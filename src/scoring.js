'use strict';

/**
 * Mind — single source of truth for scoring.
 *
 * Every results route imports from this file. Do not reimplement any of this
 * math in a route handler: divergent copies of it are what caused the 4-10 /
 * 7-10 / 5-10 drift across responses.js and personalresults.js.
 *
 * Model
 * -----
 * - Peers rate 33 attributes on a 1-10 slider.
 * - 32 attributes carry per-dimension weights (leader / manager / ic).
 * - "Ethical Behaviour" carries zero weight; it applies a penalty instead.
 * - Output is normalized to a 5.00-10.00 band and floored at 5.00.
 * - A submission only counts toward a score once all questions are answered.
 * - Multiple raters combine as one vote per rater (mean of per-rater scores).
 */

// ── Constants ────────────────────────────────────────────────────────────
const SCALE_MIN = 5;   // lowest displayable score
const SCALE_MAX = 10;  // highest displayable score
const SCALE_SPAN = SCALE_MAX - SCALE_MIN;

const RATING_MIN = 1;  // slider floor
const RATING_MAX = 10; // slider ceiling
const RATING_SPAN = RATING_MAX - RATING_MIN;

const ETHICS_ATTRIBUTE = 'Ethical Behaviour';

// Penalty multipliers applied to Y = (10 - ethicsRating) / 10.
const ETHICS_PENALTY = {
  leader: 1.5,
  manager: 1.0,
  ic: 0.75,
};

const DIMENSIONS = [
  { key: 'leader', column: 'leader_weight' },
  { key: 'manager', column: 'manager_weight' },
  { key: 'ic', column: 'ic_weight' },
];

// ── Small helpers ────────────────────────────────────────────────────────
function num(value) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value) {
  return value === null || value === undefined
    ? null
    : parseFloat(Number(value).toFixed(2));
}

function mean(values) {
  const usable = values.filter((v) => v !== null && v !== undefined);
  if (!usable.length) return null;
  return usable.reduce((a, b) => a + b, 0) / usable.length;
}

/**
 * Map a 1-10 weighted average onto the 5-10 display band.
 * avg = 1  -> 5.00
 * avg = 10 -> 10.00
 */
function normalize(weightedSum, totalWeight) {
  if (!totalWeight) return null;
  const avg = weightedSum / totalWeight;
  return SCALE_MIN + ((avg - RATING_MIN) / RATING_SPAN) * SCALE_SPAN;
}

/** Keep a score inside the band. The ethics penalty must never push below 5. */
function clampToBand(score) {
  if (score === null || score === undefined) return null;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, score));
}

// ── Core: score one rater's submission about one ratee ───────────────────
/**
 * @param {Array} rows Responses from a single (assessor, ratee) pair. Each row
 *   needs: response_value, question_id, question_text, leader_weight,
 *   manager_weight, ic_weight.
 * @returns {{leader, manager, ic, overall, ethics, answered}}
 *   Dimension scores are penalized and clamped. `overall` is the mean of the
 *   non-null dimensions. `answered` is the count of distinct questions.
 */
function scoreSubmission(rows) {
  const weightedSums = { leader: 0, manager: 0, ic: 0 };
  const weightTotals = { leader: 0, manager: 0, ic: 0 };
  const answeredQuestions = new Set();

  // Default to a perfect ethics rating so a missing row never invents a penalty.
  let ethics = RATING_MAX;

  rows.forEach((row) => {
    const value = num(row.response_value);
    answeredQuestions.add(row.question_id);

    if (row.question_text === ETHICS_ATTRIBUTE) {
      ethics = value;
    }

    DIMENSIONS.forEach(({ key, column }) => {
      const weight = num(row[column]);
      weightedSums[key] += value * weight;
      weightTotals[key] += weight;
    });
  });

  // Y ranges 0 (ethics = 10, no penalty) to 0.9 (ethics = 1, max penalty).
  const Y = (RATING_MAX - ethics) / RATING_MAX;

  const scores = {};
  DIMENSIONS.forEach(({ key }) => {
    const raw = normalize(weightedSums[key], weightTotals[key]);
    scores[key] = raw === null ? null : clampToBand(raw - ETHICS_PENALTY[key] * Y);
  });

  scores.overall = mean([scores.leader, scores.manager, scores.ic]);
  scores.ethics = ethics;
  scores.answered = answeredQuestions.size;

  return scores;
}

// ── Grouping and aggregation ─────────────────────────────────────────────
/**
 * Group flat response rows into { rateeId: { assessorId: rows[] } }.
 */
function groupByRateeAndAssessor(rows) {
  const grouped = {};
  rows.forEach((row) => {
    const ratee = row.user_id;
    const assessor = row.add_user_id;
    grouped[ratee] = grouped[ratee] || {};
    grouped[ratee][assessor] = grouped[ratee][assessor] || [];
    grouped[ratee][assessor].push(row);
  });
  return grouped;
}

/**
 * Combine several completed submissions into one score: one vote per rater.
 *
 * Deliberately NOT a pooled average over all raw responses. Pooling lets a
 * rater who answered more questions carry more influence than one who answered
 * fewer, which distorts the result based on rater behaviour rather than the
 * person being rated.
 */
function aggregateSubmissions(submissions) {
  if (!submissions.length) {
    return { leader: null, manager: null, ic: null, overall: null, raters: 0 };
  }

  const aggregate = {};
  DIMENSIONS.forEach(({ key }) => {
    aggregate[key] = mean(submissions.map((s) => s[key]));
  });
  aggregate.overall = mean(submissions.map((s) => s.overall));
  aggregate.raters = submissions.length;

  return aggregate;
}

/**
 * True once the rater has answered every question in the bank.
 * Partial submissions stay saved (so the rater can resume) but do not score.
 */
function isComplete(submission, totalQuestions) {
  return totalQuestions > 0 && submission.answered >= totalQuestions;
}

// ── Percentile ───────────────────────────────────────────────────────────
/**
 * Build the ranking pool: every ratee's aggregate score, computed only from
 * completed submissions. All routes rank against this same pool.
 */
function buildPool(allRows, totalQuestions) {
  const grouped = groupByRateeAndAssessor(allRows);
  const pool = {};

  Object.keys(grouped).forEach((rateeId) => {
    const completed = Object.values(grouped[rateeId])
      .map(scoreSubmission)
      .filter((submission) => isComplete(submission, totalQuestions));

    if (completed.length) {
      pool[rateeId] = aggregateSubmissions(completed);
    }
  });

  return pool;
}

/**
 * Percentile of `value` within the pool on the given dimension.
 * Ranks on penalized scores, so the percentile always agrees with the number
 * shown next to it.
 */
function percentileOf(value, pool, dimensionKey) {
  if (value === null || value === undefined) return 0;

  const population = Object.values(pool)
    .map((entry) => entry[dimensionKey])
    .filter((v) => v !== null && v !== undefined);

  if (population.length <= 1) return 100;

  const below = population.filter((v) => v < value).length;
  return Math.round((below / (population.length - 1)) * 100);
}

// ── Response shaping ─────────────────────────────────────────────────────
/**
 * Average each attribute across the supplied rows and return the strongest and
 * weakest five. Ethical Behaviour is excluded — it is a penalty, not a trait.
 * Ties break toward the attribute carrying more total weight.
 */
function attributeBreakdown(rows) {
  const attributes = {};

  rows
    .filter((row) => row.question_text !== ETHICS_ATTRIBUTE)
    .forEach((row) => {
      const name = row.question_text;
      if (!attributes[name]) {
        attributes[name] = {
          name,
          values: [],
          totalWeight:
            num(row.leader_weight) + num(row.manager_weight) + num(row.ic_weight),
        };
      }
      attributes[name].values.push(num(row.response_value));
    });

  const scored = Object.values(attributes).map((attribute) => ({
    name: attribute.name,
    value: mean(attribute.values),
    totalWeight: attribute.totalWeight,
  }));

  const sorted = scored.sort((a, b) =>
    b.value !== a.value ? b.value - a.value : b.totalWeight - a.totalWeight
  );

  const shape = (list) => list.map((a) => ({ name: a.name, value: round2(a.value) }));

  return {
    top5: shape(sorted.slice(0, 5)),
    bottom5: shape(sorted.slice(-5).reverse()),
  };
}

/**
 * Never claim someone is in the "Top 0%".
 *
 * The top scorer in any pool ranks at the 100th percentile, and the UI renders
 * that as `100 - percentile` = "Top 0%", which reads as though they scored
 * nothing. Floor the displayed figure at 0.1%.
 *
 * Note this is a DISPLAY floor only — `percentileOf` still returns the true
 * rank, so ordering and comparisons are unaffected.
 */
const TOP_PERCENT_FLOOR = 0.1;

function topPercent(percentile) {
  return Math.max(TOP_PERCENT_FLOOR, 100 - percentile);
}

/** Wire format for `scores`. */
function formatScores(source) {
  return {
    leader_score: round2(source.leader),
    manager_score: round2(source.manager),
    ic_score: round2(source.ic),
    overall_score: round2(source.overall),
  };
}

/**
 * Wire format for `percentiles`.
 * `total_pct` is a legacy alias for `total_percentile` — PersonalResults.jsx
 * and PeerResults.jsx read the former, Results.jsx reads the latter.
 */
function formatPercentiles(source, pool) {
  const leader = percentileOf(source.leader, pool, 'leader');
  const manager = percentileOf(source.manager, pool, 'manager');
  const ic = percentileOf(source.ic, pool, 'ic');
  const total = percentileOf(source.overall, pool, 'overall');

  return {
    leader_percentile: leader,
    manager_percentile: manager,
    ic_percentile: ic,
    total_percentile: total,
    total_pct: total,

    // Pre-floored "Top X%" figures. Render these directly — do not compute
    // `100 - percentile` in the client, or the floor is lost.
    leader_top_percent: topPercent(leader),
    manager_top_percent: topPercent(manager),
    ic_top_percent: topPercent(ic),
    total_top_percent: topPercent(total),

    pool_size: Object.keys(pool).length,
  };
}

module.exports = {
  SCALE_MIN,
  SCALE_MAX,
  ETHICS_ATTRIBUTE,
  ETHICS_PENALTY,
  DIMENSIONS,
  normalize,
  clampToBand,
  scoreSubmission,
  groupByRateeAndAssessor,
  aggregateSubmissions,
  isComplete,
  buildPool,
  percentileOf,
  topPercent,
  TOP_PERCENT_FLOOR,
  attributeBreakdown,
  formatScores,
  formatPercentiles,
  round2,
  mean,
};
