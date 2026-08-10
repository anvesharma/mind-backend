'use strict';

const db = require('./db');
const scoring = require('./scoring');
const reputation = require('./reputation');

/**
 * Database side of rater reputation: read the responses, compute, persist.
 *
 * The formula itself lives in reputation.js and is deliberately free of any
 * database dependency so it can be tested without one.
 */

/**
 * Every response belonging to a complete (rater, ratee) submission.
 *
 * Reputation compares raters against each other, so a partial submission is
 * worse than useless here — it would drag the consensus toward whoever quit
 * early. Same completeness rule as scoring: all questions answered.
 */
async function loadCompleteResponses(rateeIds = null) {
  const params = [];
  let filter = '';

  if (rateeIds && rateeIds.length) {
    params.push(rateeIds);
    filter = 'WHERE ur.user_id = ANY($1)';
  }

  const result = await db.query(
    `
    WITH complete_pairs AS (
      SELECT user_id, add_user_id
      FROM user_responses
      GROUP BY user_id, add_user_id
      HAVING COUNT(DISTINCT question_id) >= (SELECT COUNT(*) FROM questions)
    )
    SELECT ur.user_id, ur.add_user_id, ur.question_id, ur.response_value,
           q.question_text, q.leader_weight, q.manager_weight, q.ic_weight
    FROM user_responses ur
    JOIN questions q ON ur.question_id = q.question_id
    JOIN complete_pairs cp
      ON cp.user_id = ur.user_id AND cp.add_user_id = ur.add_user_id
    ${filter}
    `,
    params
  );

  return result.rows;
}

async function getTotalQuestions() {
  const result = await db.query('SELECT COUNT(*)::int AS total FROM questions');
  return result.rows[0].total;
}

async function persist(raterId, { score, pairings }) {
  await db.query(
    `UPDATE users
     SET reputation_score = $2,
         reputation_pairings = $3,
         reputation_updated_at = NOW()
     WHERE user_id = $1`,
    [raterId, score, pairings]
  );
}

/**
 * Recompute reputation for everyone affected by a completed assessment.
 *
 * Not just the rater who finished. Reputation is relative: a new rater of P
 * shifts the leave-one-out consensus for every existing rater of P, so their
 * scores move too. Recomputing only the finisher would leave the rest stale
 * and quietly wrong.
 *
 * A rater's reputation depends on every ratee they have assessed, so the
 * response set has to be loaded globally rather than scoped to this one ratee.
 *
 * @returns {Array<{raterId, score, pairings}>}
 */
async function recomputeForRatee(rateeId) {
  const [rows, totalQuestions] = await Promise.all([
    loadCompleteResponses(),
    getTotalQuestions(),
  ]);

  const grouped = scoring.groupByRateeAndAssessor(rows);
  const affected = reputation.ratersOf(grouped, rateeId);

  const results = [];
  for (const raterId of affected) {
    const computed = reputation.computeForRater(raterId, grouped, totalQuestions);
    await persist(raterId, computed);
    results.push({ raterId, ...computed });
  }

  return results;
}

/**
 * Recompute for every rater in the system. Used by the backfill script.
 * Idempotent — safe to re-run.
 */
async function recomputeAll({ onProgress } = {}) {
  const [rows, totalQuestions] = await Promise.all([
    loadCompleteResponses(),
    getTotalQuestions(),
  ]);

  const grouped = scoring.groupByRateeAndAssessor(rows);

  const raterIds = new Set();
  Object.values(grouped).forEach((byRater) => {
    Object.keys(byRater).forEach((id) => raterIds.add(id));
  });

  const results = [];
  let done = 0;

  for (const raterId of raterIds) {
    const computed = reputation.computeForRater(raterId, grouped, totalQuestions);
    await persist(raterId, computed);
    results.push({ raterId, ...computed });

    done += 1;
    if (onProgress) onProgress(done, raterIds.size);
  }

  return results;
}

module.exports = {
  loadCompleteResponses,
  getTotalQuestions,
  persist,
  recomputeForRatee,
  recomputeAll,
};
