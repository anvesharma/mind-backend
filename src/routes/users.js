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

module.exports = router;
