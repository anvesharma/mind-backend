const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

// GET /api/users/search?name=xxx — search for ratee by name
router.get('/search', authenticate, async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    const result = await db.query(
      `SELECT user_id, user_name, email FROM users
       WHERE user_name ILIKE $1 LIMIT 10`,
      [`%${name}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// POST /api/users/ratee — create or get ratee by name
router.post('/ratee', authenticate, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  try {
    // Check if user exists
    let result = await db.query(
      `SELECT user_id, user_name FROM users WHERE user_name ILIKE $1 LIMIT 1`,
      [name]
    );

    if (result.rows.length === 0) {
      // Create new user with just a name (no email)
      const guestId = `guest_${Date.now()}`;
      result = await db.query(
        `INSERT INTO users (user_name, guest_id) VALUES ($1, $2) RETURNING user_id, user_name`,
        [name, guestId]
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get or create ratee' });
  }
});


router.post('/trial-signup', authenticate, async (req, res) => {
  const userId = req.user.user_id;
  try {
    const userRes = await db.query(
      'SELECT user_name, email FROM users WHERE user_id = $1',
      [userId]
    );
    if (!userRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    await db.query(
      'UPDATE users SET trial_signup = TRUE, trial_signup_at = NOW() WHERE user_id = $1',
      [userId]
    );

    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'Mind Trials <noreply@discovermind.net>',
        to: 'nova@discovermind.net',
        subject: '\u{1F389} New free trial signup: ' + user.user_name,
        html: '<div style="font-family:sans-serif;padding:24px;"><h2 style="color:#1db88a;">New free trial signup!</h2><p><strong>Name:</strong> ' + user.user_name + '</p><p><strong>Email:</strong> ' + user.email + '</p><p><strong>Time:</strong> ' + new Date().toLocaleString() + '</p></div>'
      });
    } catch (emailErr) {
      console.error('Trial notification email failed:', emailErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Trial signup error:', err);
    res.status(500).json({ error: 'Failed to sign up for trial' });
  }
});

module.exports = router;
