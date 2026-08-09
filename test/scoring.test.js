'use strict';

/**
 * Scoring verification — no test framework, no dependencies.
 *
 *   node backend/test/scoring.test.js
 *
 * Every expected value below is computed by hand in the comment above it, so a
 * failure tells you whether the code drifted or the intent changed.
 */

const scoring = require('../src/scoring');

let passed = 0;
let failed = 0;

function check(label, actual, expected, tolerance = 0.005) {
  const ok =
    typeof expected === 'number'
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

function section(title) {
  console.log(`\n${title}`);
}

// ── Fixture: a 33-question bank, all weights 1, Ethical Behaviour at 0 ──────
const TOTAL_QUESTIONS = 33;

function buildBank() {
  const bank = [];
  for (let i = 1; i <= 32; i++) {
    bank.push({
      question_id: i,
      question_text: `Attribute ${i}`,
      leader_weight: 1,
      manager_weight: 1,
      ic_weight: 1,
    });
  }
  bank.push({
    question_id: 33,
    question_text: 'Ethical Behaviour',
    leader_weight: 0,
    manager_weight: 0,
    ic_weight: 0,
  });
  return bank;
}

/**
 * One rater's submission.
 * @param rating       value given to every weighted attribute
 * @param ethics       value given to Ethical Behaviour
 * @param answeredCount how many questions they got through (default: all)
 */
function submission(rating, ethics, answeredCount = TOTAL_QUESTIONS, ids = {}) {
  const { rateeId = 100, assessorId = 1 } = ids;
  return buildBank()
    .slice(0, answeredCount)
    .map((q) => ({
      ...q,
      user_id: rateeId,
      add_user_id: assessorId,
      response_value: q.question_text === 'Ethical Behaviour' ? ethics : rating,
    }));
}

// ── 1. Band endpoints ───────────────────────────────────────────────────────
section('Band endpoints (5.00 - 10.00)');

// Every attribute rated 1, ethics clean: avg = 1
// 5 + ((1 - 1) / 9) * 5 = 5.00
{
  const s = scoring.scoreSubmission(submission(1, 10));
  check('all 1s, clean ethics -> leader', s.leader, 5.0);
  check('all 1s, clean ethics -> manager', s.manager, 5.0);
  check('all 1s, clean ethics -> ic', s.ic, 5.0);
}

// Every attribute rated 10, ethics clean: avg = 10
// 5 + ((10 - 1) / 9) * 5 = 10.00
{
  const s = scoring.scoreSubmission(submission(10, 10));
  check('all 10s, clean ethics -> leader', s.leader, 10.0);
  check('all 10s, clean ethics -> ic', s.ic, 10.0);
}

// Midpoint: avg = 5.5 -> 5 + ((5.5 - 1) / 9) * 5 = 5 + 2.5 = 7.50
{
  const s = scoring.scoreSubmission(submission(5.5, 10));
  check('all 5.5s -> leader', s.leader, 7.5);
}

// ── 2. Ethics penalty ───────────────────────────────────────────────────────
section('Ethics penalty (Y = (10 - rating) / 10)');

// All 10s but ethics = 1 -> Y = 0.9
//   leader  = 10 - 1.5  * 0.9 = 8.65
//   manager = 10 - 1.0  * 0.9 = 9.10
//   ic      = 10 - 0.75 * 0.9 = 9.325
{
  const s = scoring.scoreSubmission(submission(10, 1));
  check('ethics 1 -> leader  (10 - 1.35)', s.leader, 8.65);
  check('ethics 1 -> manager (10 - 0.90)', s.manager, 9.1);
  check('ethics 1 -> ic      (10 - 0.675)', s.ic, 9.325);
}

// Ethics = 10 means no penalty at all.
{
  const s = scoring.scoreSubmission(submission(8, 10));
  const expected = 5 + ((8 - 1) / 9) * 5; // 8.888...
  check('ethics 10 -> no penalty on leader', s.leader, expected);
}

// A missing Ethical Behaviour row must not invent a penalty.
{
  const rows = submission(10, 10).filter(
    (r) => r.question_text !== 'Ethical Behaviour'
  );
  const s = scoring.scoreSubmission(rows);
  check('missing ethics row -> no penalty', s.leader, 10.0);
}

// ── 3. Floor clamp ──────────────────────────────────────────────────────────
section('Floor clamp at 5.00');

// All 1s AND ethics 1: leader would be 5 - 1.35 = 3.65, below the band.
{
  const s = scoring.scoreSubmission(submission(1, 1));
  check('worst case -> leader clamped', s.leader, 5.0);
  check('worst case -> manager clamped', s.manager, 5.0);
  check('worst case -> ic clamped', s.ic, 5.0);
}

// ── 4. Completion gate ──────────────────────────────────────────────────────
section('Completion gate (all 33 required)');

{
  const full = scoring.scoreSubmission(submission(8, 10));
  const partial = scoring.scoreSubmission(submission(8, 10, 20));

  check('33 of 33 answered', full.answered, 33);
  check('33 of 33 counts', scoring.isComplete(full, TOTAL_QUESTIONS), true);
  check('20 of 33 answered', partial.answered, 20);
  check('20 of 33 does not count', scoring.isComplete(partial, TOTAL_QUESTIONS), false);
}

// ── 5. Aggregation: one vote per rater ──────────────────────────────────────
section('Multi-rater aggregation');

// Three complete raters averaging 9, 4 and 7.
//   9 -> 5 + (8/9)*5 = 9.4444
//   4 -> 5 + (3/9)*5 = 6.6667
//   7 -> 5 + (6/9)*5 = 8.3333
//   mean = 24.4444 / 3 = 8.1481
{
  const raters = [9, 4, 7].map((v) => scoring.scoreSubmission(submission(v, 10)));
  const agg = scoring.aggregateSubmissions(raters);
  check('three raters -> leader', agg.leader, 8.1481);
  check('three raters -> rater count', agg.raters, 3);
}

// The distortion this prevents: the harsh rater quits after 8 questions.
// Under one-vote-per-rater they are excluded entirely (incomplete), so the
// score is the mean of the two who finished: (9.4444 + 8.3333) / 2 = 8.8889.
// Under naive pooling the harsh answers would have been diluted rather than
// excluded, silently lifting the score.
{
  const all = [
    scoring.scoreSubmission(submission(9, 10)),
    scoring.scoreSubmission(submission(4, 10, 8)), // quit early
    scoring.scoreSubmission(submission(7, 10)),
  ];
  const completed = all.filter((s) => scoring.isComplete(s, TOTAL_QUESTIONS));
  const agg = scoring.aggregateSubmissions(completed);

  check('quit-early rater excluded', completed.length, 2);
  check('two complete raters -> leader', agg.leader, 8.8889);
}

// ── 6. Percentile pool ──────────────────────────────────────────────────────
section('Percentile pool');

// Four ratees, one complete rater each, at 2 / 5 / 8 / 10.
{
  const rows = [];
  [
    [201, 2],
    [202, 5],
    [203, 8],
    [204, 10],
  ].forEach(([rateeId, rating], index) => {
    rows.push(
      ...submission(rating, 10, TOTAL_QUESTIONS, { rateeId, assessorId: 900 + index })
    );
  });

  const pool = scoring.buildPool(rows, TOTAL_QUESTIONS);
  check('pool holds 4 ratees', Object.keys(pool).length, 4);

  // Lowest scorer: nobody below -> 0. Highest: all 3 below -> 100.
  check('lowest -> 0th percentile', scoring.percentileOf(pool[201].overall, pool, 'overall'), 0);
  check('highest -> 100th percentile', scoring.percentileOf(pool[204].overall, pool, 'overall'), 100);
  // Third of four: 2 below out of 3 -> 67.
  check('third of four -> 67th', scoring.percentileOf(pool[203].overall, pool, 'overall'), 67);
}

// Incomplete submissions must not enter the pool.
{
  const rows = [
    ...submission(9, 10, TOTAL_QUESTIONS, { rateeId: 301, assessorId: 11 }),
    ...submission(9, 10, 12, { rateeId: 302, assessorId: 12 }), // incomplete
  ];
  const pool = scoring.buildPool(rows, TOTAL_QUESTIONS);
  check('incomplete ratee excluded from pool', Object.keys(pool).length, 1);
}

// ── 6b. Top-percent display floor ───────────────────────────────────────────
section('Top-percent display floor');

// 100th percentile would render as "Top 0%", which reads as a zero score.
check('100th percentile -> Top 0.1%', scoring.topPercent(100), 0.1);
check('0th percentile -> Top 100%', scoring.topPercent(0), 100);
check('67th percentile -> Top 33%', scoring.topPercent(67), 33);

// The floor is display-only: the true rank is untouched.
{
  const rows = [];
  [[401, 3], [402, 9]].forEach(([rateeId, rating], index) => {
    rows.push(
      ...submission(rating, 10, TOTAL_QUESTIONS, { rateeId, assessorId: 800 + index })
    );
  });
  const pool = scoring.buildPool(rows, TOTAL_QUESTIONS);
  const top = scoring.aggregateSubmissions([scoring.scoreSubmission(submission(9, 10))]);
  const pct = scoring.formatPercentiles(top, pool);

  check('true percentile still 100', pct.total_percentile, 100);
  check('displayed figure floored', pct.total_top_percent, 0.1);
  check('pool_size reported', pct.pool_size, 2);
}

// ── 7. Attribute breakdown ──────────────────────────────────────────────────
section('Attribute breakdown');

{
  const rows = submission(5, 3);
  rows[0].response_value = 10; // Attribute 1  -> strongest
  rows[1].response_value = 1;  // Attribute 2  -> weakest

  const { top5, bottom5 } = scoring.attributeBreakdown(rows);

  check('top5 length', top5.length, 5);
  check('strongest attribute', top5[0].name, 'Attribute 1');
  check('weakest attribute', bottom5[0].name, 'Attribute 2');

  const named = top5.concat(bottom5).map((a) => a.name);
  check('ethics excluded from breakdown', named.includes('Ethical Behaviour'), false);
}

// ── 8. Wire format ──────────────────────────────────────────────────────────
section('Wire format');

{
  const agg = scoring.aggregateSubmissions([scoring.scoreSubmission(submission(8, 10))]);
  const pool = scoring.buildPool(submission(8, 10), TOTAL_QUESTIONS);
  const scores = scoring.formatScores(agg);
  const pct = scoring.formatPercentiles(agg, pool);

  check('scores rounded to 2dp', scores.leader_score, 8.89);
  check('overall_score present', typeof scores.overall_score, 'number');
  // total_pct is the legacy alias PersonalResults.jsx and PeerResults.jsx read.
  check('total_pct mirrors total_percentile', pct.total_pct, pct.total_percentile);
}

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
