#!/usr/bin/env node
'use strict';

/**
 * Compute reputation for every rater in the database.
 *
 *   cd backend && npm run reputation:backfill
 *
 * Idempotent — safe to re-run. Run it once after migration_v8, and any time
 * you retune D_MAX in src/reputation.js.
 *
 * Requires DATABASE_URL, so it hits whatever database your .env points at.
 * Check that before running against production.
 */

require('dotenv').config();

const db = require('../src/db');
const store = require('../src/reputationstore');
const reputation = require('../src/reputation');

function summarise(results) {
  const measured = results.filter((r) => r.score !== null);
  const unmeasured = results.length - measured.length;

  console.log('\n─── Summary ─────────────────────────────────');
  console.log(`Raters processed     ${results.length}`);
  console.log(`  measured           ${measured.length}`);
  console.log(`  no valid pairing   ${unmeasured}  (stored as NULL)`);

  if (!measured.length) {
    console.log('\nNothing measurable yet.');
    console.log('Reputation needs at least one person rated by 2+ raters —');
    console.log('a rater can only be compared against a consensus that exists.');
    return;
  }

  const scores = measured.map((r) => r.score).sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

  console.log(`\nScore range          ${scores[0].toFixed(2)} – ${scores[scores.length - 1].toFixed(2)}`);
  console.log(`Mean                 ${mean.toFixed(2)}`);
  console.log(`Median               ${scores[Math.floor(scores.length / 2)].toFixed(2)}`);

  const lowConfidence = measured.filter((r) => r.pairings < 3).length;
  console.log(`\nFewer than 3 pairings  ${lowConfidence}  (heavily shrunk toward the ${reputation.PRIOR} prior)`);

  const flagged = measured
    .filter((r) => r.score < 7 && r.pairings >= 3)
    .sort((a, b) => a.score - b.score);

  if (flagged.length) {
    console.log(`\nWorth reviewing — below 7.00 with 3+ pairings:`);
    flagged.forEach((r) => {
      console.log(`  rater ${r.raterId}  ${r.score.toFixed(2)}  (${r.pairings} pairings)`);
    });
  } else {
    console.log('\nNo rater is below 7.00 with enough pairings to act on.');
  }

  // If everything lands in one bucket the calibration is not discriminating.
  const buckets = new Map();
  scores.forEach((s) => {
    const b = Math.min(9, Math.floor(s - 5));
    buckets.set(b, (buckets.get(b) || 0) + 1);
  });

  console.log('\nDistribution');
  for (let b = 0; b <= 4; b++) {
    const count = buckets.get(b) || 0;
    const lo = 5 + b;
    console.log(`  ${lo}.00–${lo + 1}.00  ${String(count).padStart(4)}  ${'#'.repeat(count)}`);
  }

  if (buckets.size === 1) {
    console.log('\nEverything landed in one bucket — D_MAX in src/reputation.js');
    console.log('is not discriminating on this data and should be retuned.');
  }
}

async function main() {
  const target = (process.env.DATABASE_URL || '').includes('localhost')
    ? 'LOCAL'
    : 'REMOTE (check this is intended)';

  console.log(`Backfilling rater reputation — target: ${target}`);
  console.log(`D_MAX ${reputation.D_MAX}   prior ${reputation.PRIOR}   prior weight ${reputation.PRIOR_WEIGHT}\n`);

  const started = Date.now();

  const results = await store.recomputeAll({
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total} raters`);
      }
    },
  });

  process.stdout.write('\n');
  summarise(results);
  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

main()
  .then(() => db.pool?.end?.())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nBackfill failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
