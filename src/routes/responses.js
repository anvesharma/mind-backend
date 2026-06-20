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
    // Raw scores — filter by assessor so multiple raters don't inflate scores
    const scoresResult = await db.query(
      `SELECT
        CAST(SUM(ur.response_value * q.leader_weight)  * 10 AS numeric) AS leader_raw,
        CAST(SUM(ur.response_value * q.manager_weight) * 10 AS numeric) AS manager_raw,
        CAST(SUM(ur.response_value * q.ic_weight)      * 10 AS numeric) AS ic_raw
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1 AND ur.add_user_id = $2`,
      [ratee_id, req.user.user_id]
    );

    const raw = scoresResult.rows[0];

    // Normalize to 7-10 scale: normalized = 7 + (raw/100) * 3
    const normalize = (v) => parseFloat((7 + (parseFloat(v) / 100) * 3).toFixed(2));

    const scores = {
      leader_score:  normalize(raw.leader_raw),
      manager_score: normalize(raw.manager_raw),
      ic_score:      normalize(raw.ic_raw),
    };

    // Percentiles — average per assessor first, then average across assessors per user
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
