const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
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
// Budget the general limit against the real cost of the product's core action.
// One complete assessment is ~38 requests:
//
//   1  POST /users/ratee
//   1  GET  /questions
//   1  GET  /responses/progress/:id
//  33  POST /responses            (one per answer — this is the bulk of it)
//   1  POST /responses/complete
//   1  GET  /responses/results/:id
//
// The previous limit of 100 per 15 minutes allowed 2.6 assessments before
// returning 429, which surfaced in the UI as "Failed to save response" partway
// through the third review. 1000 allows ~26 assessments per window.
//
// This matters most for the Uber tablet: every passenger shares one IP, and
// limits here are per-IP.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,   // RateLimit-* headers so the client can see the budget
  legacyHeaders: false,
  message: {
    error: 'Too many requests. Please wait a moment and try again.',
  },
  skip: (req) => req.path === '/health',
});
app.use(generalLimiter);

// OTP stays deliberately strict — it sends email and is the abuse-prone path.
const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OTP requests, please try again later' },
  // Only throttle OTP sending. Verifying a code, logging out and entering as a
  // guest were all sharing this 5-per-10-minute budget for no reason.
  skip: (req) => req.path !== '/send-otp',
});

app.use(express.json());

app.use('/api/auth', otpLimiter, require('./routes/auth'));
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
