const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

router.post('/', authenticate, async (req, res) => {
  const { ratee_id, question_id, response_value } = req.body;
  const assessor_id = req.user.user_id;

  if (!ratee_id || !question_id || response_value === undefined) {
    return res.status(400).json({ error: 'ratee_id, question_id and response_value are required' });
  }

  try {
    await db.query(
      `INSERT INTO user_responses (user_id, question_id, response_value, add_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, question_id, add_user_id)
       DO UPDATE SET response_value = $3`,
      [ratee_id, question_id, response_value, assessor_id]
    );

    await db.query(
      `INSERT INTO assessment_progress (assessor_id, ratee_id, last_question_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (assessor_id, ratee_id)
       DO UPDATE SET last_question_id = $3, updated_at = NOW()`,
      [assessor_id, ratee_id, question_id]
    );

    res.json({ message: 'Response saved' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save response' });
  }
});

router.post('/complete', authenticate, async (req, res) => {
  const { ratee_id } = req.body;
  const assessor_id = req.user.user_id;

  try {
    await db.query(
      `UPDATE assessment_progress SET completed = true, updated_at = NOW()
       WHERE assessor_id = $1 AND ratee_id = $2`,
      [assessor_id, ratee_id]
    );
    res.json({ message: 'Assessment completed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete assessment' });
  }
});

router.get('/progress/:ratee_id', authenticate, async (req, res) => {
  const assessor_id = req.user.user_id;
  const { ratee_id } = req.params;

  try {
    const result = await db.query(
      `SELECT ap.*, q.question_text
       FROM assessment_progress ap
       LEFT JOIN questions q ON ap.last_question_id = q.question_id
       WHERE ap.assessor_id = $1 AND ap.ratee_id = $2`,
      [assessor_id, ratee_id]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

router.get('/results/:ratee_id', authenticate, async (req, res) => {
  const { ratee_id } = req.params;

  try {
    // Step 1: Get Ethical Behaviour rating
    const ethicalRes = await db.query(
      `SELECT ur.response_value
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1 AND ur.add_user_id = $2
         AND q.question_text = 'Ethical Behaviour'`,
      [ratee_id, req.user.user_id]
    );
    const ethicalRating = ethicalRes.rows.length ? parseFloat(ethicalRes.rows[0].response_value) : 10;
    const Y = (10 - ethicalRating) / 10;
    const leaderPenalty  = 1.5 * Y;
    const managerPenalty = 1.0 * Y;
    const icPenalty      = 0.75 * Y;

    // Step 2: Weighted average per dimension
    // SUM(value * weight) / SUM(weight) → 1–10 weighted avg
    // Normalize to 7–10: 7 + ((avg - 1) / 9) * 3
    const scoresResult = await db.query(
      `SELECT
        SUM(ur.response_value * q.leader_weight)  / NULLIF(SUM(q.leader_weight),  0) AS leader_avg,
        SUM(ur.response_value * q.manager_weight) / NULLIF(SUM(q.manager_weight), 0) AS manager_avg,
        SUM(ur.response_value * q.ic_weight)      / NULLIF(SUM(q.ic_weight),      0) AS ic_avg
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1 AND ur.add_user_id = $2`,
      [ratee_id, req.user.user_id]
    );

    const raw = scoresResult.rows[0];

    const normalize = (v) => {
      if (v === null || v === undefined) return null;
      return 7 + ((parseFloat(v) - 1) / 9) * 3;
    };

    // Step 3: Apply Ethical Behaviour penalty — 1.5Y for Leader, Y for Manager
    const scores = {
      leader_score:  parseFloat((normalize(raw.leader_avg)  - leaderPenalty).toFixed(2)),
      manager_score: parseFloat((normalize(raw.manager_avg) - managerPenalty).toFixed(2)),
      ic_score:      parseFloat((normalize(raw.ic_avg)      - icPenalty).toFixed(2)),
    };

    // Step 4: Percentiles — average per assessor first, then rank globally
    const percentileResult = await db.query(
      `WITH per_assessor AS (
        SELECT
          ur.user_id,
          ur.add_user_id,
          SUM(ur.response_value * q.leader_weight)  / NULLIF(SUM(q.leader_weight),  0) AS leader_avg,
          SUM(ur.response_value * q.manager_weight) / NULLIF(SUM(q.manager_weight), 0) AS manager_avg,
          SUM(ur.response_value * q.ic_weight)      / NULLIF(SUM(q.ic_weight),      0) AS ic_avg
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.question_id
        GROUP BY ur.user_id, ur.add_user_id
      ),
      user_scores AS (
        SELECT
          user_id,
          AVG(leader_avg)  AS leader_avg,
          AVG(manager_avg) AS manager_avg,
          AVG(ic_avg)      AS ic_avg
        FROM per_assessor
        GROUP BY user_id
      )
      SELECT
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY leader_avg)  * 100 AS numeric), 0) AS leader_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY manager_avg) * 100 AS numeric), 0) AS manager_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY ic_avg)      * 100 AS numeric), 0) AS ic_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (leader_avg + manager_avg + ic_avg) / 3) * 100 AS numeric), 0) AS total_percentile
      FROM user_scores
      WHERE user_id = $1`,
      [ratee_id]
    );

    const percentiles = percentileResult.rows[0];

    const rateeResult = await db.query(
      `SELECT user_name FROM users WHERE user_id = $1`,
      [ratee_id]
    );

    res.json({
      ratee: rateeResult.rows[0],
      scores,
      percentiles,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

module.exports = router;
