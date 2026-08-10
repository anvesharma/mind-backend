'use strict';

const scoring = require('./scoring');

/**
 * Rater reputation.
 *
 * WHAT IT MEASURES
 * ----------------
 * How closely a rater's assessment of someone matches what everyone else who
 * rated that same person concluded. A rater who consistently lands near the
 * consensus is producing usable signal; one who does not is producing noise.
 *
 * Scored 5.00 (completely off) to 10.00 (exact match), matching the scale used
 * for talent scores so the two read consistently.
 *
 * WHAT IT DOES NOT MEASURE
 * ------------------------
 * Whether the rater is RIGHT. Agreement is a proxy for reliability, not truth.
 * A rater who correctly spots something everyone else missed is mathematically
 * indistinguishable from one who is simply wrong. That is the central reason
 * this number should not be shown to raters — the moment people can see it,
 * the incentive is to rate toward the middle to protect it, which destroys the
 * dissenting signal that makes peer assessment worth doing.
 *
 * Compared on the three dimension scores (Leader / Manager / IC), not on the
 * 33 raw attributes: two raters can weight individual traits differently and
 * still agree on the shape of the person, which is what matters.
 */

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Deviation at which a rater is considered "completely off".
 *
 * Calibrated by simulation against the real attribute weights. At D_MAX = 1.0
 * on the 5-10 band, with 10 pairings:
 *
 *   careful rater (sigma 0.8)   deviation 0.13   ->  9.30
 *   typical rater (sigma 1.5)   deviation 0.21   ->  8.97
 *   sloppy  rater (sigma 3.0)   deviation 0.34   ->  8.37
 *   random ratings              deviation 0.54   ->  6.83
 *   same number 33 times        deviation 0.71   ->  6.19
 *   systematically +2           deviation 1.22   ->  5.46
 *
 * Lower D_MAX widens the spread but starts penalising honest-but-imprecise
 * raters. Retune once real multi-rater data exists — the simulated deviations
 * above are the thing to check against.
 */
const D_MAX = 1.0;

/** Where a rater with no track record sits: a little below a typical rater. */
const PRIOR = 8.5;

/**
 * Strength of the prior, in units of pairing weight. At k = 3 a single pairing
 * moves a rater roughly a third of the way from the prior toward their measured
 * accuracy — enough to be visible, not enough to be trusted.
 */
const PRIOR_WEIGHT = 3;

const SCORE_MIN = 5;
const SCORE_MAX = 10;

const DIMENSIONS = ['leader', 'manager', 'ic'];

// ── Pairing-level ────────────────────────────────────────────────────────────

/**
 * Middle value of a list. Even counts average the two middle values.
 *
 * The consensus uses the median rather than the mean so a single extreme rater
 * cannot drag it. With the mean, one person rating everyone 10 while four rate
 * them 6 pulled the consensus far enough that all four honest raters were
 * scored as inaccurate — they were being measured against a target the outlier
 * had moved. Median: honest raters 9.10, outlier 7.10. Mean: honest raters
 * 7.77, outlier 7.10.
 *
 * Below three peers the median and the mean are identical, so this costs
 * nothing at low rater counts and helps as they grow.
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Mean absolute deviation between one rater's dimension scores and the
 * consensus of the others, averaged across Leader / Manager / IC.
 *
 * Dimensions where either side has no score (no weighted attributes answered)
 * are skipped rather than counted as zero deviation, which would look like
 * perfect agreement.
 *
 * @returns {number|null} null if no dimension could be compared.
 */
function deviation(mine, others) {
  if (!mine || !others || !others.length) return null;

  let total = 0;
  let counted = 0;

  DIMENSIONS.forEach((dim) => {
    const own = mine[dim];
    if (own === null || own === undefined) return;

    const peerValues = others
      .map((o) => o[dim])
      .filter((v) => v !== null && v !== undefined);

    if (!peerValues.length) return;

    total += Math.abs(own - median(peerValues));
    counted += 1;
  });

  return counted ? total / counted : null;
}

/** Map a deviation onto the 5-10 band. 0 -> 10.00, D_MAX or worse -> 5.00. */
function accuracy(dev) {
  if (dev === null || dev === undefined) return null;
  return SCORE_MAX - (SCORE_MAX - SCORE_MIN) * Math.min(dev / D_MAX, 1);
}

/**
 * Confidence in a single pairing, as a weight.
 *
 * Agreeing with five people is stronger evidence than agreeing with one, but
 * not five times stronger — hence the square root rather than a plain count.
 */
function pairingWeight(otherRaterCount) {
  return Math.sqrt(Math.max(otherRaterCount, 0));
}

/**
 * Evaluate one (rater, ratee) pairing.
 *
 * @param {object} mySubmission        Output of scoring.scoreSubmission for the rater.
 * @param {Array<object>} otherSubmissions  Same, for every OTHER complete rater of the ratee.
 *
 * Leaving the rater out of their own consensus is not optional. Include them
 * and, with two raters, each is half of the target they are measured against —
 * so everyone looks accurate and the metric means nothing.
 *
 * @returns {{accuracy, weight, deviation, others}|null} null if not comparable.
 */
function evaluatePairing(mySubmission, otherSubmissions) {
  const peers = (otherSubmissions || []).filter(Boolean);
  if (!peers.length) return null;

  const dev = deviation(mySubmission, peers);
  if (dev === null) return null;

  return {
    deviation: dev,
    accuracy: accuracy(dev),
    weight: pairingWeight(peers.length),
    others: peers.length,
  };
}

// ── Rater-level ──────────────────────────────────────────────────────────────

/**
 * Combine a rater's pairings into one reputation score.
 *
 * Shrinks toward PRIOR so a single lucky pairing cannot produce a 10.00 and a
 * single bad one cannot produce a 5.00. With 10 solid pairings the worst
 * attainable score is about 5.46; exactly 5.00 requires a long record of being
 * completely off, which is the intended meaning.
 *
 * @returns {{score: number|null, pairings: number}} score is null when the
 *   rater has no comparable pairing — nobody else has rated anyone they rated.
 *   Null rather than PRIOR, so "unmeasured" stays distinguishable from
 *   "measured at 8.50".
 */
function reputationFrom(pairings) {
  const usable = (pairings || []).filter((p) => p && p.accuracy !== null);

  if (!usable.length) {
    return { score: null, pairings: 0 };
  }

  let weightedAccuracy = 0;
  let totalWeight = 0;

  usable.forEach((p) => {
    weightedAccuracy += p.weight * p.accuracy;
    totalWeight += p.weight;
  });

  const raw =
    (weightedAccuracy + PRIOR_WEIGHT * PRIOR) / (totalWeight + PRIOR_WEIGHT);

  return {
    score: parseFloat(Math.min(SCORE_MAX, Math.max(SCORE_MIN, raw)).toFixed(2)),
    pairings: usable.length,
  };
}

/**
 * Full calculation from raw response rows.
 *
 * @param {number|string} raterId
 * @param {object} responsesByRatee  { rateeId: { raterId: rows[] } } — only
 *   COMPLETE submissions should be passed in; incomplete ones do not score.
 * @param {number} totalQuestions
 */
function computeForRater(raterId, responsesByRatee, totalQuestions) {
  const pairings = [];

  Object.keys(responsesByRatee).forEach((rateeId) => {
    const byRater = responsesByRatee[rateeId];

    // A rater's opinion of themselves tells us nothing about their reliability,
    // and self-assessment is a different act from peer assessment.
    if (String(rateeId) === String(raterId)) return;

    const mine = byRater[raterId];
    if (!mine) return;

    const mySubmission = scoring.scoreSubmission(mine);
    if (!scoring.isComplete(mySubmission, totalQuestions)) return;

    const otherSubmissions = Object.keys(byRater)
      .filter((id) => String(id) !== String(raterId))
      .map((id) => scoring.scoreSubmission(byRater[id]))
      .filter((s) => scoring.isComplete(s, totalQuestions));

    const pairing = evaluatePairing(mySubmission, otherSubmissions);
    if (pairing) pairings.push(pairing);
  });

  return reputationFrom(pairings);
}

/**
 * Every rater who submitted a complete assessment of the given ratee.
 *
 * Needed because reputation is relative: when a new rater completes an
 * assessment of P, the leave-one-out consensus shifts for every existing rater
 * of P, so all of their reputations change too.
 */
function ratersOf(responsesByRatee, rateeId) {
  const byRater = responsesByRatee[rateeId] || {};
  return Object.keys(byRater);
}

module.exports = {
  D_MAX,
  PRIOR,
  PRIOR_WEIGHT,
  SCORE_MIN,
  SCORE_MAX,
  DIMENSIONS,
  median,
  deviation,
  accuracy,
  pairingWeight,
  evaluatePairing,
  reputationFrom,
  computeForRater,
  ratersOf,
};
