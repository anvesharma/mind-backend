const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/create-checkout', authenticate, async (req, res) => {
  const { emails, rateeId } = req.body;
  const userId = req.user.user_id;
  if (!emails || emails.length < 3 || emails.length > 5) {
    return res.status(400).json({ error: 'Please enter 3-5 email addresses' });
  }
  try {
    const sessionRes = await db.query(`
      INSERT INTO social_sessions (user_id, ratee_id, emails, status, expires_at)
      VALUES ($1, $2, $3, 'pending', NOW() + INTERVAL '7 days')
      RETURNING id
    `, [userId, rateeId, JSON.stringify(emails)]);
    const socialSessionId = sessionRes.rows[0].id;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Mind for You — Real Peer Rating',
            description: 'Get rated by up to 5 people who know you best.',
          },
          unit_amount: 199,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment-success?session_id={CHECKOUT_SESSION_ID}&social_id=${socialSessionId}`,
      cancel_url: `${process.env.FRONTEND_URL}/discover`,
      metadata: { socialSessionId: String(socialSessionId), userId: String(userId) }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.post('/payment-success', authenticate, async (req, res) => {
  const { sessionId, socialId } = req.body;
  const userId = req.user.user_id;
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not confirmed' });
    }
    const socialRes = await db.query(
      'SELECT * FROM social_sessions WHERE id = $1 AND user_id = $2',
      [socialId, userId]
    );
    if (!socialRes.rows.length) return res.status(404).json({ error: 'Session not found' });
    const social = socialRes.rows[0];
    if (social.status === 'paid') return res.json({ success: true, alreadyProcessed: true });
    const emails = JSON.parse(social.emails);
    const rateeId = social.ratee_id;
    const rateeRes = await db.query('SELECT user_name FROM users WHERE user_id = $1', [rateeId]);
    const rateeName = rateeRes.rows[0]?.user_name || 'someone';
    const userRes = await db.query('SELECT user_name FROM users WHERE user_id = $1', [userId]);
    const userName = userRes.rows[0]?.user_name || 'A friend';
    const tokens = [];
    for (const email of emails) {
      const token = crypto.randomBytes(32).toString('hex');
      await db.query(`
        INSERT INTO social_tokens (social_session_id, email, token, ratee_id, completed)
        VALUES ($1, $2, $3, $4, false)
      `, [socialId, email, token, rateeId]);
      tokens.push({ email, token });
    }
    for (const { email, token } of tokens) {
      await resend.emails.send({
        from: 'Mind <noreply@discovermind.net>',
        to: email,
        subject: `${userName} wants to know what you really think of them`,
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#060d1a;color:#f0f4f8;padding:40px 32px;border-radius:16px;"><div style="text-align:center;margin-bottom:32px;"><span style="color:#ef9f27;font-size:20px;font-weight:700;">✦ Mind for You</span></div><h1 style="font-size:24px;font-weight:700;margin-bottom:12px;color:#ffffff;">${userName} wants your honest opinion</h1><p style="color:#7a9ab5;font-size:15px;line-height:1.6;margin-bottom:24px;">They've invited you to rate <strong style="color:#f0f4f8;">${rateeName}</strong> on Mind — a quick peer assessment that reveals their real leadership style and strengths.</p><p style="color:#7a9ab5;font-size:14px;margin-bottom:32px;">It takes about 5 minutes. Your rating is anonymous.</p><div style="text-align:center;margin-bottom:32px;"><a href="${process.env.FRONTEND_URL}/rate/${token}" style="background:#ef9f27;color:#050810;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">Rate ${rateeName} now →</a></div><p style="color:#3a5a70;font-size:12px;text-align:center;">This link is unique to you. Results are only visible to ${userName}.</p></div>`
      });
    }
    await db.query("UPDATE social_sessions SET status = 'paid' WHERE id = $1", [socialId]);
    res.json({ success: true, emailsSent: emails.length });
  } catch (err) {
    console.error('Payment success error:', err.message);
    res.status(500).json({ error: 'Failed to process payment' });
  }
});

router.get('/rate/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const tokenRes = await db.query(
      'SELECT st.*, u.user_name FROM social_tokens st JOIN users u ON st.ratee_id = u.user_id WHERE st.token = $1',
      [token]
    );
    if (!tokenRes.rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    const t = tokenRes.rows[0];
    if (t.completed) return res.status(400).json({ error: 'You have already submitted your rating' });
    const questions = await db.query('SELECT * FROM questions ORDER BY RANDOM()');
    res.json({ ratee: { user_id: t.ratee_id, user_name: t.user_name }, questions: questions.rows, token });
  } catch (err) {
    console.error('Rate token error:', err.message);
    res.status(500).json({ error: 'Failed to load rating' });
  }
});

router.post('/rate/:token/submit', async (req, res) => {
  const { token } = req.params;
  const { responses } = req.body;
  try {
    const tokenRes = await db.query(
      'SELECT st.*, ss.user_id FROM social_tokens st JOIN social_sessions ss ON st.social_session_id = ss.id WHERE st.token = $1',
      [token]
    );
    if (!tokenRes.rows.length) return res.status(404).json({ error: 'Invalid link' });
    const t = tokenRes.rows[0];
    if (t.completed) return res.status(400).json({ error: 'Already submitted' });
    for (const r of responses) {
      await db.query(`
        INSERT INTO user_responses (user_id, question_id, response_value, add_user_id, weight)
        VALUES ($1, $2, $3, $4, 1) ON CONFLICT DO NOTHING
      `, [t.ratee_id, r.question_id, r.response_value, t.social_session_id]);
    }
    await db.query('UPDATE social_tokens SET completed = true WHERE token = $1', [token]);
    const completedRes = await db.query(
      'SELECT COUNT(*) FROM social_tokens WHERE social_session_id = $1 AND completed = true',
      [t.social_session_id]
    );
    const completedCount = parseInt(completedRes.rows[0].count);
    if (completedCount >= 3) {
      const userRes = await db.query(
        'SELECT u.user_name, u.email FROM social_sessions ss JOIN users u ON ss.user_id = u.user_id WHERE ss.id = $1',
        [t.social_session_id]
      );
      const user = userRes.rows[0];
      if (user?.email) {
        await resend.emails.send({
          from: 'Mind <noreply@discovermind.net>',
          to: user.email,
          subject: 'Your Mind results are ready!',
          html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;background:#060d1a;color:#f0f4f8;padding:40px 32px;border-radius:16px;"><div style="text-align:center;margin-bottom:32px;"><span style="color:#ef9f27;font-size:20px;font-weight:700;">✦ Mind for You</span></div><h1 style="font-size:24px;font-weight:700;color:#ef9f27;">Your real results are in, ${user.user_name}!</h1><p style="color:#7a9ab5;font-size:15px;line-height:1.6;margin:16px 0 32px;">At least 3 people have rated you. Your real scores and top talents are ready.</p><div style="text-align:center;"><a href="${process.env.FRONTEND_URL}/personal-results/${t.ratee_id}" style="background:#ef9f27;color:#050810;padding:14px 32px;border-radius:12px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">See my results →</a></div></div>`
        });
      }
    }
    res.json({ success: true, completedCount });
  } catch (err) {
    console.error('Submit rating error:', err.message);
    res.status(500).json({ error: 'Failed to submit rating' });
  }
});

router.get('/status/:socialId', authenticate, async (req, res) => {
  const { socialId } = req.params;
  try {
    const result = await db.query(`
      SELECT COUNT(*) FILTER (WHERE completed = true) as completed, COUNT(*) as total
      FROM social_tokens WHERE social_session_id = $1
    `, [socialId]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

module.exports = router;
