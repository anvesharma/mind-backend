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

router.get('/results/:ratee_id', authenticate, async (req, res) => {
  const { ratee_id } = req.params;

  try {
    // ─── Step 1: Weighted average per dimension ───────────────────────────────
    // Excludes Ethical Behaviour (weight = 0) from the weighted average.
    // Formula: SUM(response_value × weight) / SUM(weight) → 1–10 weighted avg
    // Normalization: 5 + ((avg - 1) / 9) * 5 → 5.00–10.00
    //   • A peer rating of 1 on every attribute → 5.00
    //   • A peer rating of 10 on every attribute → 10.00
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
      [ratee_id, req.user.user_id]
    );

    // ─── Step 2: Fetch Ethical Behaviour rating ───────────────────────────────
    // Used only for the penalty — not included in the weighted average above.
    const ethicsResult = await db.query(
      `SELECT ur.response_value AS ethics_score
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1
         AND ur.add_user_id = $2
         AND q.question_text = 'Ethical Behaviour'
       LIMIT 1`,
      [ratee_id, req.user.user_id]
    );

    const raw = scoresResult.rows[0];

    // ─── Step 3: Normalize to 5–10 scale ─────────────────────────────────────
    const normalize = (v) => {
      if (v === null || v === undefined) return null;
      return parseFloat((5 + ((parseFloat(v) - 1) / 9) * 5).toFixed(2));
    };

    const scores = {
      leader_score:  normalize(raw.leader_avg),
      manager_score: normalize(raw.manager_avg),
      ic_score:      normalize(raw.ic_avg),
    };

    // ─── Step 4: Apply Ethical Behaviour penalty ──────────────────────────────
    // Y = (10 - X) / 10, where X is the Ethical Behaviour peer rating (1–10)
    // Leader  penalty: subtract 1.5 × Y from leader_score
    // Manager penalty: subtract 1.0 × Y from manager_score
    // A perfect ethics score (X=10) → Y=0 → no penalty
    // A zero ethics score  (X=1)  → Y=0.9 → max penalty of 1.35 (L) / 0.90 (M)
    if (ethicsResult.rows.length > 0) {
      const X = parseFloat(ethicsResult.rows[0].ethics_score);
      const Y = (10 - X) / 10;

      if (scores.leader_score  !== null) {
        scores.leader_score  = parseFloat(Math.max(5, scores.leader_score  - 1.5 * Y).toFixed(2));
      }
      if (scores.manager_score !== null) {
        scores.manager_score = parseFloat(Math.max(5, scores.manager_score - 1.0 * Y).toFixed(2));
      }
    }

    // ─── Step 5: Percentiles ──────────────────────────────────────────────────
    // Uses the same weighted average (Ethical Behaviour excluded from weights).
    // Penalty is NOT applied to percentile base — percentile reflects raw talent
    // signal; the penalty is a display-layer adjustment on the final score.
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
        ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (leader_avg + manager_avg + ic_avg)) * 100 AS numeric), 0) AS total_percentile
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
