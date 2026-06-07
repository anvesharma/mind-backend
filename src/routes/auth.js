const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const db = require('../db');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);

// Generate 6-digit OTP
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

// POST /api/auth/send-otp
router.post('/send-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  try {
    const otp = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Invalidate old OTPs for this email
    await db.query(
      `UPDATE otp_verifications SET verified = true WHERE email = $1 AND verified = false`,
      [email]
    );

    // Store new OTP
    await db.query(
      `INSERT INTO otp_verifications (email, otp_code, expires_at) VALUES ($1, $2, $3)`,
      [email, otp, expiresAt]
    );

    // Send email
    await resend.emails.send({
      from: process.env.OTP_FROM_EMAIL,
      to: email,
      subject: 'Your Discover Mind verification code',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Discover Mind</h2>
          <p>Your verification code is:</p>
          <h1 style="letter-spacing: 8px; color: #1a1a2e;">${otp}</h1>
          <p style="color: #666;">This code expires in 10 minutes.</p>
        </div>
      `,
    });

    res.json({ message: 'OTP sent successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp
router.post('/verify-otp', async (req, res) => {
  const { email, otp, name } = req.body;
  if (!email || !otp || !name) {
    return res.status(400).json({ error: 'Email, OTP and name are required' });
  }

  try {
    // Check OTP
    const otpResult = await db.query(
      `SELECT * FROM otp_verifications
       WHERE email = $1 AND otp_code = $2
       AND verified = false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [email, otp]
    );

    if (otpResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    // Mark OTP as verified
    await db.query(
      `UPDATE otp_verifications SET verified = true WHERE id = $1`,
      [otpResult.rows[0].id]
    );

    // Get or create user
    let userResult = await db.query(
      `SELECT * FROM users WHERE email = $1`,
      [email]
    );

    let user;
    if (userResult.rows.length === 0) {
      const guestId = `guest_${Date.now()}`;
      const insertResult = await db.query(
        `INSERT INTO users (user_name, email, guest_id)
         VALUES ($1, $2, $3) RETURNING *`,
        [name, email, guestId]
      );
      user = insertResult.rows[0];
    } else {
      user = userResult.rows[0];
      // Update name if changed
      await db.query(
        `UPDATE users SET user_name = $1 WHERE user_id = $2`,
        [name, user.user_id]
      );
      user.user_name = name;
    }

    // Create session token
    const token = jwt.sign(
      { user_id: user.user_id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO sessions (session_token, user_id, expires_at) VALUES ($1, $2, $3)`,
      [token, user.user_id, expiresAt]
    );

    res.json({
      token,
      user: {
        user_id: user.user_id,
        user_name: user.user_name,
        email: user.email,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (token) {
    await db.query(`DELETE FROM sessions WHERE session_token = $1`, [token]);
  }
  res.json({ message: 'Logged out' });
});

module.exports = router;
