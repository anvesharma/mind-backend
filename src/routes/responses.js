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
       VALUES ($1, $2, $3, $4)`,
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

// Shared handler used by both /results/:ratee_id and /personal-results/:rateeId
async function getResults(rateeId, assessorId, res) {
  try {
    const scoresResult = await db.query(
      `SELECT
        SUM(ur.response_value * q.leader_weight)  / NULLIF(SUM(q.leader_weight),  0) AS leader_avg,
        SUM(ur.response_value * q.manager_weight) / NULLIF(SUM(q.manager_weight), 0) AS manager_avg,
        SUM(ur.response_value * q.ic_weight)      / NULLIF(SUM(q.ic_weight),      0) AS ic_avg
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1
         AND ur.add_user_id = $2
         AND q.question_text != 'Ethical Behaviour'`,
      [rateeId, assessorId]
    );

    const ethicsResult = await db.query(
      `SELECT ur.response_value AS ethics_score
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1
         AND ur.add_user_id = $2
         AND q.question_text = 'Ethical Behaviour'
       LIMIT 1`,
      [rateeId, assessorId]
    );

    const raw = scoresResult.rows[0];

    const normalize = (v) => {
      if (v === null || v === undefined) return null;
      return parseFloat((5 + ((parseFloat(v) - 1) / 9) * 5).toFixed(2));
    };

    const scores = {
      leader_score:  normalize(raw.leader_avg),
      manager_score: normalize(raw.manager_avg),
      ic_score:      normalize(raw.ic_avg),
    };

    if (ethicsResult.rows.length > 0) {
      const X = parseFloat(ethicsResult.rows[0].ethics_score);
      const Y = (10 - X) / 10;
      if (scores.leader_score  !== null) scores.leader_score  = parseFloat(Math.max(5, scores.leader_score  - 1.5 * Y).toFixed(2));
      if (scores.manager_score !== null) scores.manager_score = parseFloat(Math.max(5, scores.manager_score - 1.0 * Y).toFixed(2));
    }

    const percentileResult = await db.query(
      `WITH user_scores AS (
        SELECT
          ur.user_id,
          SUM(ur.response_value * q.leader_weight)  / NULLIF(SUM(q.leader_weight),  0) AS leader_avg,
          SUM(ur.response_value * q.manager_weight) / NULLIF(SUM(q.manager_weight), 0) AS manager_avg,
          SUM(ur.response_value * q.ic_weight)      / NULLIF(SUM(q.ic_weight),      0) AS ic_avg
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.question_id
        WHERE q.question_text != 'Ethical Behaviour'
        GROUP BY ur.user_id
      )
      SELECT
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY leader_avg)  * 100 AS numeric), 0) AS leader_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY manager_avg) * 100 AS numeric), 0) AS manager_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY ic_avg)      * 100 AS numeric), 0) AS ic_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (leader_avg + manager_avg + ic_avg)) * 100 AS numeric), 0) AS total_percentile,
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (leader_avg + manager_avg + ic_avg)) * 100 AS numeric), 0) AS total_pct
      FROM user_scores
      WHERE user_id = $1`,
      [rateeId]
    );

    const percentiles = percentileResult.rows[0] || {
      leader_percentile: 0, manager_percentile: 0, ic_percentile: 0,
      total_percentile: 0, total_pct: 0,
    };

    const rateeResult = await db.query(
      `SELECT user_name FROM users WHERE user_id = $1`,
      [rateeId]
    );

    const responsesRes = await db.query(
      `SELECT
        ur.response_value,
        q.question_text,
        q.leader_weight,
        q.manager_weight,
        q.ic_weight
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1 AND ur.add_user_id = $2`,
      [rateeId, assessorId]
    );

    const attributeMap = {};
    responsesRes.rows.forEach(r => {
      const name = r.question_text;
      if (!attributeMap[name]) {
        attributeMap[name] = {
          name,
          value: r.response_value,
          total_weight: (parseFloat(r.leader_weight) || 0) + (parseFloat(r.manager_weight) || 0) + (parseFloat(r.ic_weight) || 0),
        };
      }
    });

    const sorted = Object.values(attributeMap).sort((a, b) => {
      if (b.value !== a.value) return b.value - a.value;
      return b.total_weight - a.total_weight;
    });

    const top5    = sorted.slice(0, 5).map(a => ({ name: a.name, value: a.value }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: a.value }));

    res.json({
      ratee: rateeResult.rows[0],
      scores,
      percentiles,
      top5,
      bottom5,
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get results' });
  }
}

router.get('/results/:ratee_id', authenticate, (req, res) => {
  getResults(req.params.ratee_id, req.user.user_id, res);
});

router.get('/personal-results/:rateeId', authenticate, (req, res) => {
  getResults(req.params.rateeId, req.user.user_id, res);
});

module.exports = router;
