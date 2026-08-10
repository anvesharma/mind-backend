'use strict';

/**
 * Percentile pool cache verification.
 *
 *   node backend/test/poolcache.test.js
 *
 * A stale percentile is worse than a slow one, so most of these check that the
 * cache MISSES when it should.
 */

const cache = require('../src/poolcache');

let passed = 0;
let failed = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
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

const POOL = { 1: { overall: 8.1 }, 2: { overall: 6.4 } };
const T0 = 1_000_000;

// ── Hits ────────────────────────────────────────────────────────────────────
section('Cache hits');

cache.invalidate();
assert('cold cache misses', cache.get(33, T0) === null);

cache.set(POOL, 33, T0);
check('set then get returns the same pool', cache.get(33, T0), POOL);
check('still warm just before the TTL', cache.get(33, T0 + cache.TTL_MS - 1), POOL);

// ── Misses ──────────────────────────────────────────────────────────────────
section('Cache misses');

assert('expires exactly at the TTL', cache.get(33, T0 + cache.TTL_MS) === null);
assert('expired after the TTL', cache.get(33, T0 + cache.TTL_MS + 5000) === null);

// If the question bank changed, the completion gate moved and every cached
// submission was scored against a different rule. Not comparable.
cache.set(POOL, 33, T0);
assert('different question count misses', cache.get(34, T0) === null, 'stale gate served');
check('original question count still hits', cache.get(33, T0), POOL);

// ── Invalidation ────────────────────────────────────────────────────────────
section('Invalidation');

cache.set(POOL, 33, T0);
cache.invalidate();
assert('invalidate clears the entry', cache.get(33, T0) === null);
assert('invalidate is safe to call twice', (cache.invalidate(), cache.get(33, T0) === null));

// A completed assessment must be visible to the next reader immediately, not
// after the TTL — this is the path POST /responses/complete takes.
{
  cache.set(POOL, 33, T0);
  const NEW_POOL = { ...POOL, 3: { overall: 9.2 } };

  cache.invalidate();          // what /complete does
  assert('post-completion read misses', cache.get(33, T0) === null);

  cache.set(NEW_POOL, 33, T0); // rebuilt on the next request
  check('rebuilt pool is served', cache.get(33, T0), NEW_POOL);
  check('rebuilt pool has the new ratee', Object.keys(cache.get(33, T0)).length, 3);
}

// ── Overwrite ───────────────────────────────────────────────────────────────
section('Overwrite');

{
  const A = { 1: { overall: 5 } };
  const B = { 2: { overall: 9 } };

  cache.set(A, 33, T0);
  cache.set(B, 33, T0 + 10);

  check('later set replaces the earlier one', cache.get(33, T0 + 10), B);
  // The clock restarts on the new entry, so it must not inherit A's age.
  check('TTL restarts on overwrite', cache.get(33, T0 + cache.TTL_MS + 5), B);
}

// ── Stats ───────────────────────────────────────────────────────────────────
section('Stats');

cache.invalidate();
check('cold cache reports uncached', cache.stats(T0).cached, false);

cache.set(POOL, 33, T0);
{
  const s = cache.stats(T0 + 1500);
  check('reports cached', s.cached, true);
  check('reports age', s.ageMs, 1500);
  check('reports pool size', s.size, 2);
  check('reports question count', s.totalQuestions, 33);
}

cache.invalidate();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
