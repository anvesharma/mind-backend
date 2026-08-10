'use strict';

/**
 * Rater reputation verification.
 *
 *   node backend/test/reputation.test.js
 *
 * Covers the arithmetic, the leave-one-out rule, the shrinkage behaviour, and
 * a calibration check against simulated rater archetypes — if a future tweak to
 * D_MAX stops separating a careful rater from a random one, that last section
 * fails.
 */

const scoring = require('../src/scoring');
const reputation = require('../src/reputation');

let passed = 0;
let failed = 0;

function check(label, actual, expected, tolerance = 0.005) {
  const ok =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) <= tolerance
      : actual === expected;
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}  ->  ${actual}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}  ->  got ${actual}, expected ${expected}`);
  }
}

function assert(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}  ${detail}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

// The real weights, so calibration is checked against production behaviour.
const WEIGHTS = [
  ['Courage', 10, 0, 0], ['Vision', 10, 0, 0], ['Adaptability', 9, 6, 2],
  ['Listening', 9, 9, 0], ['Resilience', 9, 5, 2], ['Humility', 7, 5, 0],
  ['Communication', 7, 9, 0], ['Ethical Behaviour', 0, 0, 0], ['Creativity', 0, 0, 1],
  ['Empathy', 8, 5, 0], ['Execution', 9, 6, 3], ['Confidence', 8, 6, 2],
  ['Self Awareness', 9, 6, 0], ['Ownership', 10, 7, 5], ['Negotiation', 7, 5, 0],
  ['Trustworthiness', 10, 10, 3], ['Critical Thinking', 7, 5, 5], ['Storytelling', 9, 3, 0],
  ['Curiosity', 6, 3, 1], ['Problem Solving', 8, 8, 8], ['Planning', 7, 7, 1],
  ['Consistency', 9, 7, 4], ['Accountability', 9, 7, 4], ['Judgement', 10, 8, 5],
  ['Discipline', 9, 8, 4], ['Time Management', 9, 7, 2], ['Coordination', 6, 9, 0],
  ['Strategic Thinking', 10, 5, 0], ['Decision Making', 10, 7, 3], ['Influence', 8, 3, 0],
  ['Inspiration', 10, 0, 0], ['Coaching', 6, 10, 0], ['Collaboration', 10, 10, 0],
];

const TOTAL_QUESTIONS = WEIGHTS.length;

/** Build response rows from a vector of 33 ratings. */
function rows(values, count = TOTAL_QUESTIONS) {
  return WEIGHTS.slice(0, count).map(([name, l, m, i], idx) => ({
    question_id: idx + 1,
    question_text: name,
    leader_weight: l,
    manager_weight: m,
    ic_weight: i,
    response_value: values[idx],
  }));
}

const flat = (v) => Array.from({ length: TOTAL_QUESTIONS }, () => v);

// Deterministic pseudo-random, so calibration results are reproducible.
let seed = 7;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
function gauss() {
  return Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ── Deviation ───────────────────────────────────────────────────────────────
section('Deviation');

check(
  'identical scores -> 0',
  reputation.deviation({ leader: 8, manager: 7, ic: 6 }, [{ leader: 8, manager: 7, ic: 6 }]),
  0
);

// Off by 1 on every dimension -> mean absolute deviation of 1.
check(
  'uniformly 1 higher -> 1',
  reputation.deviation({ leader: 9, manager: 8, ic: 7 }, [{ leader: 8, manager: 7, ic: 6 }]),
  1
);

// (|9-8| + |7-7| + |6-6|) / 3
check(
  'one dimension off by 1 -> 0.333',
  reputation.deviation({ leader: 9, manager: 7, ic: 6 }, [{ leader: 8, manager: 7, ic: 6 }]),
  1 / 3
);

// Two peers: the median is the mean of the two. (8 + 6) / 2 = 7, so |9 - 7| = 2.
check(
  'two peers -> midpoint',
  reputation.deviation({ leader: 9, manager: 7, ic: 6 }, [
    { leader: 8, manager: 7, ic: 6 },
    { leader: 6, manager: 7, ic: 6 },
  ]),
  2 / 3
);

// Three peers where one is extreme: the median ignores its magnitude.
// Peers are 6, 6 and 10 -> median 6, so a rater at 6 deviates by 0.
// Under a mean consensus (7.33) that same rater would have looked 1.33 off.
check(
  'median resists one extreme peer',
  reputation.deviation({ leader: 6, manager: 6, ic: 6 }, [
    { leader: 6, manager: 6, ic: 6 },
    { leader: 6, manager: 6, ic: 6 },
    { leader: 10, manager: 10, ic: 10 },
  ]),
  0
);

// A dimension nobody could score must be skipped, not counted as agreement.
check(
  'null dimension is skipped, not scored as 0',
  reputation.deviation({ leader: 9, manager: null, ic: 6 }, [{ leader: 8, manager: null, ic: 6 }]),
  0.5
);

assert('no peers -> null', reputation.deviation({ leader: 8 }, []) === null);

section('Median');

check('odd count takes the middle', reputation.median([1, 5, 9]), 5);
check('even count averages the middle two', reputation.median([1, 5, 9, 13]), 7);
check('single value', reputation.median([7]), 7);
check('two values match the mean', reputation.median([6, 8]), 7);
check('unsorted input', reputation.median([9, 1, 5]), 5);
// The property the whole switch depends on.
check('an extreme value does not move it', reputation.median([6, 6, 6, 100]), 6);

// ── Accuracy mapping ────────────────────────────────────────────────────────
section('Accuracy mapping (D_MAX = 1.0)');

check('exact match -> 10.00', reputation.accuracy(0), 10);
check('half of D_MAX -> 7.50', reputation.accuracy(0.5), 7.5);
check('at D_MAX -> 5.00', reputation.accuracy(reputation.D_MAX), 5);
check('beyond D_MAX stays 5.00', reputation.accuracy(4), 5);
check('typical rater deviation 0.21 -> 8.95', reputation.accuracy(0.21), 8.95);

// ── Pairing weight ──────────────────────────────────────────────────────────
section('Pairing weight');

check('1 other rater -> 1', reputation.pairingWeight(1), 1);
check('4 other raters -> 2', reputation.pairingWeight(4), 2);
check('9 other raters -> 3', reputation.pairingWeight(9), 3);
assert(
  'more peers is worth more, but sub-linearly',
  reputation.pairingWeight(4) < 4 * reputation.pairingWeight(1)
);

// ── Shrinkage ───────────────────────────────────────────────────────────────
section('Shrinkage toward the prior');

check('no pairings -> null score', reputation.reputationFrom([]).score, null);
check('no pairings -> 0 counted', reputation.reputationFrom([]).pairings, 0);

// (1 x 10 + 3 x 8.5) / (1 + 3) = 35.5 / 4
{
  const r = reputation.reputationFrom([{ accuracy: 10, weight: 1 }]);
  check('one perfect pairing is not 10.00', r.score, 8.88);
  assert('one perfect pairing stays below 9', r.score < 9);
}

// (20 x 10 + 25.5) / 23
{
  const many = Array.from({ length: 10 }, () => ({ accuracy: 10, weight: 2 }));
  const r = reputation.reputationFrom(many);
  check('ten perfect pairings approach 10', r.score, 9.8);
  check('pairings counted', r.pairings, 10);
}

// (20 x 5 + 25.5) / 23 — the floor is asymptotic, not immediate.
{
  const many = Array.from({ length: 10 }, () => ({ accuracy: 5, weight: 2 }));
  check('ten terrible pairings -> 5.46, not 5.00', reputation.reputationFrom(many).score, 5.46);
}

// A long record of being completely off does eventually reach the floor.
{
  const many = Array.from({ length: 200 }, () => ({ accuracy: 5, weight: 3 }));
  assert('a long bad record approaches 5.00', reputation.reputationFrom(many).score < 5.1);
}

assert(
  'result is always inside the band',
  [
    reputation.reputationFrom([{ accuracy: 10, weight: 999 }]).score,
    reputation.reputationFrom([{ accuracy: 5, weight: 999 }]).score,
  ].every((s) => s >= 5 && s <= 10)
);

// ── Leave-one-out ───────────────────────────────────────────────────────────
section('Leave-one-out');

// The failure this prevents: scoring a rater against an average that contains
// their own rating. With two raters each would be half their own target, and
// everybody would look accurate.
{
  const byRatee = {
    100: {
      1: rows(flat(10)), // the outlier
      2: rows(flat(6)),
      3: rows(flat(6)),
      4: rows(flat(6)),
      5: rows(flat(6)),
    },
  };

  const outlier = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  const agreeing = reputation.computeForRater('2', byRatee, TOTAL_QUESTIONS);

  assert(
    'the outlier scores below those who agree',
    outlier.score < agreeing.score,
    `${outlier.score} vs ${agreeing.score}`
  );
  assert('the outlier is measurably penalised', outlier.score < 7.5, `${outlier.score}`);

  // The reason for the median. Under a mean consensus the honest raters scored
  // 7.77 here, dragged down by a colleague's bad assessment. They now sit where
  // people who agree with each other should.
  assert(
    'honest raters are not contaminated by the outlier',
    agreeing.score > 9,
    `${agreeing.score}`
  );
}

// KNOWN LIMIT: below three peers the median IS the mean, so a single outlier
// still contaminates. With three raters the outlier is half of the two-peer
// consensus each honest rater is measured against, and all three score alike.
// Nothing fixes this — with one peer and one outlier there is no majority to
// find. It resolves as rater counts grow; guarded here so it stays explicit.
{
  const byRatee = { 100: { 1: rows(flat(10)), 2: rows(flat(6)), 3: rows(flat(6)) } };

  const outlier = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  const agreeing = reputation.computeForRater('2', byRatee, TOTAL_QUESTIONS);

  check('three raters: outlier and honest rater are indistinguishable', outlier.score, agreeing.score);
}

// Two raters who agree exactly should both be at the ceiling for their volume.
{
  const byRatee = { 100: { 1: rows(flat(7)), 2: rows(flat(7)) } };
  const r = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  check('perfect agreement, one pairing', r.score, 8.88);
}

// ── Exclusions ──────────────────────────────────────────────────────────────
section('Exclusions');

// Nobody else rated this person, so there is no consensus to compare against.
{
  const byRatee = { 100: { 1: rows(flat(7)) } };
  const r = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  check('solo rater -> null, not a default score', r.score, null);
  check('solo rater -> 0 pairings', r.pairings, 0);
}

// Rating yourself says nothing about your reliability as a peer rater.
{
  const byRatee = { 1: { 1: rows(flat(9)), 2: rows(flat(5)) } };
  const r = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  check('self-assessment is excluded', r.pairings, 0);
}

// Incomplete submissions do not score and must not drag the consensus.
{
  const byRatee = {
    100: {
      1: rows(flat(7)),
      2: rows(flat(1), 10), // answered only 10 of 33
    },
  };
  const r = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  check('incomplete peer is ignored', r.pairings, 0);
}

{
  const byRatee = {
    100: {
      1: rows(flat(7), 10), // the rater themselves is incomplete
      2: rows(flat(7)),
    },
  };
  const r = reputation.computeForRater('1', byRatee, TOTAL_QUESTIONS);
  check('own incomplete submission does not count', r.pairings, 0);
}

// ── Affected raters ─────────────────────────────────────────────────────────
section('Affected raters');

{
  const byRatee = { 100: { 1: rows(flat(7)), 2: rows(flat(6)), 3: rows(flat(8)) } };
  const affected = reputation.ratersOf(byRatee, '100');
  check('all raters of a ratee are returned', affected.length, 3);
  assert('unknown ratee returns empty', reputation.ratersOf(byRatee, '999').length === 0);
}

// ── Calibration ─────────────────────────────────────────────────────────────
section('Calibration against rater archetypes');

function trueProfile() {
  return WEIGHTS.map(() => clamp(Math.round(6 + gauss() * 2.2), 1, 10));
}

const ARCHETYPES = {
  careful: (t) => t.map((v) => clamp(Math.round(v + gauss() * 0.8), 1, 10)),
  typical: (t) => t.map((v) => clamp(Math.round(v + gauss() * 1.5), 1, 10)),
  sloppy: (t) => t.map((v) => clamp(Math.round(v + gauss() * 3.0), 1, 10)),
  flat: () => flat(7),
  generous: (t) => t.map((v) => clamp(Math.round(v + 2), 1, 10)),
  random: () => WEIGHTS.map(() => clamp(Math.round(1 + rand() * 9), 1, 10)),
};

function simulate(buildRating, rateeCount = 10, peers = 4) {
  seed = 7;
  const pairings = [];

  for (let i = 0; i < rateeCount; i++) {
    const truth = trueProfile();
    const mine = scoring.scoreSubmission(rows(buildRating(truth)));
    const others = Array.from({ length: peers }, () =>
      scoring.scoreSubmission(rows(ARCHETYPES.typical(truth)))
    );
    const pairing = reputation.evaluatePairing(mine, others);
    if (pairing) pairings.push(pairing);
  }

  return reputation.reputationFrom(pairings).score;
}

const results = {};
Object.entries(ARCHETYPES).forEach(([name, fn]) => {
  results[name] = simulate(fn);
  console.log(`        ${name.padEnd(10)} ${results[name].toFixed(2)}`);
});

assert(
  'careful outranks typical',
  results.careful > results.typical,
  `${results.careful} vs ${results.typical}`
);
assert(
  'typical outranks sloppy',
  results.typical > results.sloppy,
  `${results.typical} vs ${results.sloppy}`
);
assert(
  'sloppy outranks random',
  results.sloppy > results.random,
  `${results.sloppy} vs ${results.random}`
);
assert(
  'systematic bias is penalised hardest',
  results.generous < results.random,
  `generous ${results.generous} vs random ${results.random}`
);
assert(
  'flat-clicking is caught',
  results.flat < results.sloppy,
  `flat ${results.flat} vs sloppy ${results.sloppy}`
);

// The whole point: a real rater and a useless one must be far apart. If a
// change to D_MAX collapses this gap, the metric has stopped working.
assert(
  'careful and random differ by more than 1.5',
  results.careful - results.random > 1.5,
  `spread ${(results.careful - results.random).toFixed(2)}`
);
assert(
  'good raters stay comfortably above 8',
  results.careful > 8 && results.typical > 8,
  `${results.careful} / ${results.typical}`
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
