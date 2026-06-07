const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

// GET /api/questions
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT question_id, question_text, leader_weight, manager_weight, ic_weight
       FROM questions ORDER BY question_id`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch questions' });
  }
});

module.exports = router;
