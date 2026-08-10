const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const limits = require('./ratelimit');
require('dotenv').config();

const app = express();

app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin: [
    'https://www.discovermind.net',
    'https://discovermind.net',
    'https://mind-frontend.vercel.app',
    'http://localhost:3000',
  ],
  credentials: true,
}));

// ── Rate limiting ────────────────────────────────────────────────────────────
//
// Keyed on the caller's session rather than their IP. An office shares one
// public IP, so IP-keyed limits mean one employee rating colleagues quickly
// locks out the whole company. See src/ratelimit.js for the full reasoning
// and the numbers.
//
// The original config was 100 requests / 15 min per IP. One assessment costs
// ~38 requests, so that allowed 2.6 reviews before returning 429 — which the
// UI reported as "Failed to save response" partway through a third review.
const generalLimiter = rateLimit({
  windowMs: limits.WINDOW_MS,
  max: limits.GENERAL_MAX,
  keyGenerator: limits.sessionKey,
  standardHeaders: true,   // RateLimit-* headers so the client can see the budget
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
  skip: (req) => req.path === '/health',
});
app.use(generalLimiter);

// express.json() must run before the OTP limiters — otpKey reads req.body.email.
app.use(express.json());

// Keyed on the target email: stops one inbox being spammed without blocking
// the sixth colleague to sign up from the same office.
const otpEmailLimiter = rateLimit({
  windowMs: limits.OTP_WINDOW_MS,
  max: limits.OTP_MAX_PER_EMAIL,
  keyGenerator: limits.otpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests for this email, please try again later' },
  // Only throttle OTP sending. Verifying a code, logging out and guest entry
  // were all sharing this 5-per-10-minute budget for no reason.
  skip: (req) => req.path !== '/send-otp',
});

// Backstop: catches a script rotating through addresses to dodge the email key,
// while still leaving room for a whole office to onboard the same morning.
const otpIpLimiter = rateLimit({
  windowMs: limits.OTP_WINDOW_MS,
  max: limits.OTP_MAX_PER_IP,
  keyGenerator: limits.ipKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests, please try again later' },
  skip: (req) => req.path !== '/send-otp',
});

app.use('/api/auth', otpIpLimiter, otpEmailLimiter, require('./routes/auth'));
app.use('/api/questions', require('./routes/questions'));
app.use('/api/users', require('./routes/users'));
app.use('/api/responses', require('./routes/responses'));
app.use('/api/social', require('./routes/social'));
app.use('/api/tts', require('./routes/tts'));
app.use('/api/nova-chat', require('./routes/novachat'));
app.use('/api/influencer-applications', require('./routes/influencer'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Mind backend running on port ${PORT}`);
});

module.exports = app;
