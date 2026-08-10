'use strict';

/**
 * In-memory cache for the percentile pool.
 *
 * WHY
 * ---
 * Building the pool means reading every completed response in the database and
 * scoring every submission. That was happening on every single results request,
 * including a page refresh, which made the results page take seconds to render.
 *
 * The pool only changes when somebody finishes an assessment. Between those
 * events it is identical for every viewer, so it is cached process-wide and
 * invalidated on completion. The TTL is a backstop for anything that changes
 * the data without going through POST /responses/complete — a direct database
 * edit, or a rater who abandons and resumes across processes.
 *
 * Deliberately process-local. Railway may run more than one instance, in which
 * case each keeps its own copy and they can disagree for up to the TTL. That is
 * acceptable for a percentile — it is a relative ranking over a slow-moving
 * population, not a balance. Move to Redis if that stops being true.
 */

const TTL_MS = 60 * 1000;

let entry = null; // { pool, totalQuestions, builtAt }

/**
 * @param {number} totalQuestions Size of the question bank the pool was built
 *   against. A change here means the completion gate moved and the cached pool
 *   is no longer comparable, so it is treated as a miss.
 * @param {number} now Injectable for tests.
 * @returns {object|null} The cached pool, or null on a miss.
 */
function get(totalQuestions, now = Date.now()) {
  if (!entry) return null;
  if (entry.totalQuestions !== totalQuestions) return null;
  if (now - entry.builtAt >= TTL_MS) return null;
  return entry.pool;
}

function set(pool, totalQuestions, now = Date.now()) {
  entry = { pool, totalQuestions, builtAt: now };
  return pool;
}

/** Call whenever a submission completes. */
function invalidate() {
  entry = null;
}

/** Test/debug visibility. */
function stats(now = Date.now()) {
  if (!entry) return { cached: false };
  return {
    cached: true,
    ageMs: now - entry.builtAt,
    totalQuestions: entry.totalQuestions,
    size: Object.keys(entry.pool || {}).length,
  };
}

module.exports = { get, set, invalidate, stats, TTL_MS };
