const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

// GET /api/responses/personal-results/:rateeId
router.get('/personal-results/:rateeId', authenticate, async (req, res) => {
  const { rateeId } = req.params;
  const assessorId = req.user.user_id;

  try {
    // Get ratee info
    const rateeRes = await db.query(
      'SELECT user_id, user_name FROM users WHERE user_id = $1',
      [rateeId]
    );
    if (!rateeRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const ratee = rateeRes.rows[0];

    // Get all responses with question details
    const responsesRes = await db.query(`
      SELECT 
        ur.response_value,
        q.question_text,
        q.leader_weight,
        q.manager_weight,
        q.ic_weight
      FROM user_responses ur
      JOIN questions q ON ur.question_id = q.question_id
      WHERE ur.ratee_id = $1 AND ur.add_user_id = $2
    `, [rateeId, assessorId]);

    const responses = responsesRes.rows;
    if (!responses.length) return res.status(404).json({ error: 'No responses found' });

    // Calculate per-attribute scores
    // Group by question_text, compute weighted contribution
    const attributeMap = {};
    responses.forEach(r => {
      const name = r.question_text;
      if (!attributeMap[name]) {
        attributeMap[name] = {
          name,
          value: r.response_value,
          leader_weight: parseFloat(r.leader_weight) || 0,
          manager_weight: parseFloat(r.manager_weight) || 0,
          ic_weight: parseFloat(r.ic_weight) || 0,
          total_weight: (parseFloat(r.leader_weight) || 0) + (parseFloat(r.manager_weight) || 0) + (parseFloat(r.ic_weight) || 0),
        };
      }
    });

    const attributes = Object.values(attributeMap);

    // Sort: by value DESC, then by total_weight DESC as tiebreaker
    const sorted = [...attributes].sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return b.total_weight - a.total_weight;
    });

    const top5 = sorted.slice(0, 5).map(a => ({ name: a.name, value: a.value }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: a.value }));

    // Get L/M/IC scores and percentiles (reuse existing logic)
    const scoresRes = await db.query(`
      SELECT
        ROUND(CAST(
          7 + (SUM(ur.response_value * q.leader_weight) * 10 / 100) * 3
        AS numeric), 2) AS leader_score,
        ROUND(CAST(
          7 + (SUM(ur.response_value * q.manager_weight) * 10 / 100) * 3
        AS numeric), 2) AS manager_score,
        ROUND(CAST(
          7 + (SUM(ur.response_value * q.ic_weight) * 10 / 100) * 3
        AS numeric), 2) AS ic_score
      FROM user_responses ur
      JOIN questions q ON ur.question_id = q.question_id
      WHERE ur.ratee_id = $1 AND ur.add_user_id = $2
    `, [rateeId, assessorId]);

    const scores = scoresRes.rows[0];

    // Percentile using PERCENT_RANK
    const percentileRes = await db.query(`
      WITH all_scores AS (
        SELECT
          ur.ratee_id,
          7 + (SUM(ur.response_value * q.leader_weight) * 10 / 100) * 3 AS leader_score,
          7 + (SUM(ur.response_value * q.manager_weight) * 10 / 100) * 3 AS manager_score,
          7 + (SUM(ur.response_value * q.ic_weight) * 10 / 100) * 3 AS ic_score
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.question_id
        GROUP BY ur.ratee_id, ur.add_user_id
      ),
      ranked AS (
        SELECT
          ratee_id,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY leader_score) * 100 AS numeric), 0) AS leader_pct,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY manager_score) * 100 AS numeric), 0) AS manager_pct,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY ic_score) * 100 AS numeric), 0) AS ic_pct,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (leader_score + manager_score + ic_score)/3) * 100 AS numeric), 0) AS total_pct
        FROM all_scores
      )
      SELECT leader_pct, manager_pct, ic_pct, total_pct FROM ranked WHERE ratee_id = $1
    `, [rateeId]);

    const percentiles = percentileRes.rows[0] || { leader_pct: 0, manager_pct: 0, ic_pct: 0, total_pct: 0 };

    res.json({
      ratee,
      scores,
      percentiles,
      top5,
      bottom5,
    });
  } catch (err) {
    console.error('Personal results error:', err.message);
    res.status(500).json({ error: 'Failed to get personal results' });
  }
});

module.exports = router;
