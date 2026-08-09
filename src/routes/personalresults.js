/**
 * RETIRED — do not mount this file.
 *
 * This router held a second, divergent copy of the scoring logic: a 7-10
 * normalization band and a percentile query that ranked on UNPENALIZED scores.
 * It was never registered in app.js, so every request to /personal-results
 * fell through to the 404 handler.
 *
 * Its routes now live in routes/responses.js:
 *   GET /api/responses/personal-results/:rateeId
 *   GET /api/responses/personal-results/peer/:rateeId
 *
 * All scoring math lives in src/scoring.js. Keep it there — one copy.
 *
 * Safe to `git rm` this file.
 */

module.exports = null;
