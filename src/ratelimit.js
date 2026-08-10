'use strict';

const crypto = require('crypto');

/**
 * Rate limit key strategies.
 *
 * Kept dependency-free (crypto is built in) so it can be unit tested without
 * standing up Express. app.js builds the actual limiters from these.
 *
 * WHY NOT KEY ON IP
 * -----------------
 * A whole office shares one public IP. Keying on IP means one employee rating
 * colleagues quickly can lock out everyone else at the company. The session
 * token identifies the person, so each user gets their own budget wherever
 * they are. IP remains the fallback for unauthenticated traffic, where there
 * is nothing better to key on.
 */

/**
 * Normalise an IP for use as a limit key.
 *
 * IPv6 clients are routinely handed a whole /64 and can rotate addresses
 * within it freely, so limiting a single IPv6 address limits nothing. Bucket
 * to the /64 and the rotation stops helping.
 */
function ipKey(req) {
  const ip = (req && req.ip) || '';
  if (!ip) return 'ip:unknown';

  if (ip.includes(':')) {
    const prefix = ip.split(':').slice(0, 4).join(':');
    return `ip6:${prefix}::/64`;
  }
  return `ip4:${ip}`;
}

/**
 * Key on the caller's session, falling back to IP when unauthenticated.
 *
 * The raw JWT is hashed rather than used directly — limit keys end up in
 * memory stores and log lines, and a bearer token should not.
 */
function sessionKey(req) {
  const header = (req && req.headers && req.headers.authorization) || '';

  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token) {
      const digest = crypto.createHash('sha256').update(token).digest('hex');
      return `session:${digest.slice(0, 32)}`;
    }
  }

  return ipKey(req);
}

/**
 * Key OTP sends on the target email address.
 *
 * Keyed on IP, the sixth person to sign up from a customer's office gets
 * blocked — which looks like a broken product on the first day of a rollout.
 * Keyed on email, the limit does what it is actually for: stopping one inbox
 * being spammed. A separate IP backstop handles email rotation.
 */
function otpKey(req) {
  const email = req && req.body && req.body.email;
  if (typeof email === 'string' && email.trim()) {
    return `otp:${email.trim().toLowerCase()}`;
  }
  return ipKey(req);
}

/**
 * Cost of one complete assessment, in requests:
 *
 *   1  POST /users/ratee
 *   1  GET  /questions
 *   1  GET  /responses/progress/:id
 *  33  POST /responses          (one per answer)
 *   1  POST /responses/complete
 *   1  GET  /responses/results/:id
 *
 * Limits are budgeted as multiples of this.
 */
const REQUESTS_PER_ASSESSMENT = 38;

/**
 * Window length is a tradeoff, not a constant. A long window means a user who
 * trips the limit is locked out for that whole window. 5 minutes caps the
 * damage while still smoothing bursts.
 */
const WINDOW_MS = 5 * 60 * 1000;

/** ~8 assessments per 5 minutes — far past any human pace, tight on a loop. */
const GENERAL_MAX = 300;

const OTP_WINDOW_MS = 10 * 60 * 1000;
const OTP_MAX_PER_EMAIL = 5;
const OTP_MAX_PER_IP = 60;

module.exports = {
  ipKey,
  sessionKey,
  otpKey,
  REQUESTS_PER_ASSESSMENT,
  WINDOW_MS,
  GENERAL_MAX,
  OTP_WINDOW_MS,
  OTP_MAX_PER_EMAIL,
  OTP_MAX_PER_IP,
};
