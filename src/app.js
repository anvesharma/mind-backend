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

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
});
app.use(limiter);

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: { error: 'Too many OTP requests, please try again later' },
});

app.use(express.json());

app.use('/api/auth', otpLimiter, require('./routes/auth'));
app.use('/api/questions', require('./routes/questions'));
app.use('/api/users', require('./routes/users'));
app.use('/api/responses', require('./routes/responses'));
app.use('/api/responses/personal-results', require('./routes/personalresults'));
app.use('/api/social', require('./routes/social'));
app.use('/api/tts', require('./routes/tts'));
app.use('/api/nova-chat', require('./routes/novachat'));

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
