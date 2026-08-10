'use strict';

/**
 * Rate limit key verification.
 *
 *   node backend/test/ratelimit.test.js
 *
 * The point of these keys is that two different people never share a bucket
 * and one person never gets two. Each assertion below is one way that could
 * go wrong.
 */

const limits = require('../src/ratelimit');

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

const req = ({ ip, token, email } = {}) => ({
  ip,
  headers: token ? { authorization: `Bearer ${token}` } : {},
  body: email === undefined ? {} : { email },
});

// ── Session keys ────────────────────────────────────────────────────────────
section('Session keys');

// The whole point: same office IP, different people, different buckets.
{
  const a = limits.sessionKey(req({ ip: '203.0.113.9', token: 'token-alice' }));
  const b = limits.sessionKey(req({ ip: '203.0.113.9', token: 'token-bob' }));

  assert('two users behind one office IP get separate buckets', a !== b, `${a} === ${b}`);
  assert('session key is used, not the IP', a.startsWith('session:'), a);
}

// One person must stay in one bucket across requests, or the limit never bites.
{
  const first = limits.sessionKey(req({ ip: '203.0.113.9', token: 'token-alice' }));
  const later = limits.sessionKey(req({ ip: '198.51.100.4', token: 'token-alice' }));

  check('same session on a different network -> same bucket', later, first);
}

// The raw JWT must never become the limit key.
{
  const token = 'eyJhbGciOiJIUzI1NiJ9.secret-payload.signature';
  const key = limits.sessionKey(req({ ip: '203.0.113.9', token }));

  assert('token is hashed, not stored raw', !key.includes('secret-payload'), key);
  check('key length is bounded', key.length, 'session:'.length + 32);
}

// Unauthenticated traffic has nothing better to key on than IP.
{
  const key = limits.sessionKey(req({ ip: '203.0.113.9' }));
  assert('no token -> falls back to IP', key.startsWith('ip4:'), key);
}

// A malformed header must not produce an empty shared bucket.
{
  const key = limits.sessionKey({ ip: '203.0.113.9', headers: { authorization: 'Bearer ' } });
  assert('empty bearer token -> falls back to IP', key.startsWith('ip4:'), key);
}

// ── IP keys ─────────────────────────────────────────────────────────────────
section('IP keys');

check('IPv4 is used as-is', limits.ipKey(req({ ip: '203.0.113.9' })), 'ip4:203.0.113.9');

// An IPv6 client is typically handed a whole /64 and can rotate inside it at
// will. Limiting one address limits nothing.
{
  const a = limits.ipKey(req({ ip: '2001:db8:1234:5678:aaaa:bbbb:cccc:dddd' }));
  const b = limits.ipKey(req({ ip: '2001:db8:1234:5678:1111:2222:3333:4444' }));

  check('IPv6 buckets to /64', a, 'ip6:2001:db8:1234:5678::/64');
  check('rotating within a /64 does not escape the limit', b, a);
}

{
  const other = limits.ipKey(req({ ip: '2001:db8:1234:9999:aaaa:bbbb:cccc:dddd' }));
  assert(
    'a genuinely different /64 is a different bucket',
    other !== 'ip6:2001:db8:1234:5678::/64',
    other
  );
}

assert('missing IP does not throw', limits.ipKey({}) === 'ip:unknown');

// ── OTP keys ────────────────────────────────────────────────────────────────
section('OTP keys');

// The failure this prevents: the sixth employee signing up from a customer's
// office being told the product is rate limited.
{
  const a = limits.otpKey(req({ ip: '203.0.113.9', email: 'alice@acme.com' }));
  const b = limits.otpKey(req({ ip: '203.0.113.9', email: 'bob@acme.com' }));

  assert('colleagues on one IP get separate OTP buckets', a !== b, `${a} === ${b}`);
}

// Casing and stray whitespace must not mint a fresh bucket per attempt.
{
  const plain = limits.otpKey(req({ ip: '203.0.113.9', email: 'alice@acme.com' }));

  check('uppercase normalises', limits.otpKey(req({ email: 'ALICE@acme.com' })), plain);
  check('whitespace normalises', limits.otpKey(req({ email: '  alice@acme.com  ' })), plain);
}

// Without an email there is nothing to key on but the IP.
{
  assert('missing email -> IP', limits.otpKey(req({ ip: '203.0.113.9' })).startsWith('ip4:'));
  assert('blank email -> IP', limits.otpKey(req({ ip: '203.0.113.9', email: '   ' })).startsWith('ip4:'));
  assert(
    'non-string email -> IP',
    limits.otpKey({ ip: '203.0.113.9', headers: {}, body: { email: 42 } }).startsWith('ip4:')
  );
}

// ── Budgets ─────────────────────────────────────────────────────────────────
section('Budgets');

check('assessment cost', limits.REQUESTS_PER_ASSESSMENT, 38);

{
  const perWindow = limits.GENERAL_MAX / limits.REQUESTS_PER_ASSESSMENT;
  const minutes = limits.WINDOW_MS / 60000;
  const secondsPerAssessment = (minutes * 60) / perWindow;

  console.log(
    `        ${perWindow.toFixed(1)} assessments per ${minutes} min ` +
      `= one every ${secondsPerAssessment.toFixed(0)}s at the cap`
  );

  // The old config allowed 2.6 per window, which real use exceeded.
  assert('allows more than 5 assessments per window', perWindow > 5, `${perWindow}`);
  // A cap so high it never trips is not a limit.
  assert('still caps a runaway client', perWindow < 20, `${perWindow}`);
  // Lockout should be minutes, not a quarter of an hour.
  assert('lockout capped at 5 minutes', minutes <= 5, `${minutes} min`);
}

assert('OTP per-email limit is strict', limits.OTP_MAX_PER_EMAIL <= 5);
assert(
  'OTP IP backstop leaves room for an office',
  limits.OTP_MAX_PER_IP >= 40,
  `${limits.OTP_MAX_PER_IP}`
);
assert(
  'IP backstop is looser than the email limit',
  limits.OTP_MAX_PER_IP > limits.OTP_MAX_PER_EMAIL
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
