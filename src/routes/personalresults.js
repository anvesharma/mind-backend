const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

// Helper: weighted average → normalize to 7–10
// SUM(value * weight) / SUM(weight) gives a 1–10 weighted avg
// then: 7 + ((avg - 1) / 9) * 3 maps 1→7.00, 10→10.00
function normalize(weightedSum, totalWeight) {
  if (!totalWeight) return 7.00;
  const avg = weightedSum / totalWeight;
  return parseFloat((7 + ((avg - 1) / 9) * 3).toFixed(2));
}

// ── Peer route (no auth — used for public share links) ──────────────────
router.get('/peer/:rateeId', async (req, res) => {
  const { rateeId } = req.params;
  try {
    const rateeRes = await db.query(
      'SELECT user_id, user_name FROM users WHERE user_id = $1',
      [rateeId]
    );
    if (!rateeRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const ratee = rateeRes.rows[0];

    const responsesRes = await db.query(`
      SELECT ur.response_value, ur.add_user_id, q.question_text,
        q.leader_weight, q.manager_weight, q.ic_weight
      FROM user_responses ur
      JOIN questions q ON ur.question_id = q.question_id
      WHERE ur.user_id = $1
    `, [rateeId]);

    const responses = responsesRes.rows;
    if (!responses.length) return res.status(404).json({ error: 'No responses found' });

    // Group by rater, compute weighted avg per rater, then average across raters
    const raterMap = {};
    responses.forEach(r => {
      const rid = r.add_user_id;
      if (!raterMap[rid]) raterMap[rid] = [];
      raterMap[rid].push(r);
    });

    const raterScores = Object.values(raterMap).map(rr => {
      const lSum  = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.leader_weight)  || 0), 0);
      const mSum  = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.manager_weight) || 0), 0);
      const iSum  = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.ic_weight)      || 0), 0);
      const lW    = rr.reduce((s, r) => s + (parseFloat(r.leader_weight)  || 0), 0);
      const mW    = rr.reduce((s, r) => s + (parseFloat(r.manager_weight) || 0), 0);
      const iW    = rr.reduce((s, r) => s + (parseFloat(r.ic_weight)      || 0), 0);
      return {
        ls:  normalize(lSum, lW),
        ms:  normalize(mSum, mW),
        ics: normalize(iSum, iW),
      };
    });

    const n = raterScores.length;
    const scores = {
      leader_score:  parseFloat((raterScores.reduce((s, r) => s + r.ls,  0) / n).toFixed(2)),
      manager_score: parseFloat((raterScores.reduce((s, r) => s + r.ms,  0) / n).toFixed(2)),
      ic_score:      parseFloat((raterScores.reduce((s, r) => s + r.ics, 0) / n).toFixed(2)),
    };

    // Top/bottom attributes: average response value across all raters per question
    const attrMap = {};
    responses.forEach(r => {
      if (!attrMap[r.question_text]) {
        attrMap[r.question_text] = {
          name: r.question_text,
          values: [],
          lw: parseFloat(r.leader_weight)  || 0,
          mw: parseFloat(r.manager_weight) || 0,
          iw: parseFloat(r.ic_weight)      || 0,
        };
      }
      attrMap[r.question_text].values.push(parseFloat(r.response_value));
    });
    Object.values(attrMap).forEach(a => {
      a.value = a.values.reduce((s, v) => s + v, 0) / a.values.length;
      a.total_weight = a.lw + a.mw + a.iw;
    });

    const sorted = Object.values(attrMap).sort((a, b) =>
      b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight
    );
    const top5    = sorted.slice(0, 5).map(a => ({ name: a.name, value: parseFloat(a.value.toFixed(2)) }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: parseFloat(a.value.toFixed(2)) }));

    res.json({ ratee, scores, percentiles: { total_pct: 0 }, top5, bottom5 });
  } catch (err) {
    console.error('Peer results error:', err.message);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// ── Main personal results route (authenticated) ─────────────────────────
router.get('/:rateeId', authenticate, async (req, res) => {
  const { rateeId } = req.params;
  const assessorId = req.user.user_id;
  try {
    const rateeRes = await db.query(
      'SELECT user_id, user_name FROM users WHERE user_id = $1',
      [rateeId]
    );
    if (!rateeRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const ratee = rateeRes.rows[0];

    const responsesRes = await db.query(`
      SELECT ur.response_value, q.question_text,
        q.leader_weight, q.manager_weight, q.ic_weight
      FROM user_responses ur
      JOIN questions q ON ur.question_id = q.question_id
      WHERE ur.user_id = $1 AND ur.add_user_id = $2
    `, [rateeId, assessorId]);

    const responses = responsesRes.rows;
    if (!responses.length) return res.status(404).json({ error: 'No responses found' });

    // Weighted average per dimension
    const lSum = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.leader_weight)  || 0), 0);
    const mSum = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.manager_weight) || 0), 0);
    const iSum = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.ic_weight)      || 0), 0);
    const lW   = responses.reduce((s, r) => s + (parseFloat(r.leader_weight)  || 0), 0);
    const mW   = responses.reduce((s, r) => s + (parseFloat(r.manager_weight) || 0), 0);
    const iW   = responses.reduce((s, r) => s + (parseFloat(r.ic_weight)      || 0), 0);

    const scores = {
      leader_score:  normalize(lSum, lW),
      manager_score: normalize(mSum, mW),
      ic_score:      normalize(iSum, iW),
    };

    // Top/bottom attributes by raw response value
    const attrMap = {};
    responses.forEach(r => {
      if (!attrMap[r.question_text]) {
        attrMap[r.question_text] = {
          name: r.question_text,
          value: parseFloat(r.response_value),
          total_weight: (parseFloat(r.leader_weight) || 0) + (parseFloat(r.manager_weight) || 0) + (parseFloat(r.ic_weight) || 0),
        };
      }
    });

    const sorted = Object.values(attrMap).sort((a, b) =>
      b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight
    );
    const top5    = sorted.slice(0, 5).map(a => ({ name: a.name, value: a.value }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: a.value }));

    // Percentile using correct weighted average formula
    const percentileRes = await db.query(`
      WITH all_scores AS (
        SELECT
          ur.user_id,
          SUM(ur.response_value * q.leader_weight)  / NULLIF(SUM(q.leader_weight),  0) AS l_avg,
          SUM(ur.response_value * q.manager_weight) / NULLIF(SUM(q.manager_weight), 0) AS m_avg,
          SUM(ur.response_value * q.ic_weight)      / NULLIF(SUM(q.ic_weight),      0) AS i_avg
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.question_id
        GROUP BY ur.user_id
      ),
      ranked AS (
        SELECT user_id,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (l_avg + m_avg + i_avg) / 3) * 100 AS numeric), 0) AS total_pct
        FROM all_scores
      )
      SELECT total_pct FROM ranked WHERE user_id = $1 LIMIT 1
    `, [rateeId]);

    const percentiles = percentileRes.rows[0] || { total_pct: 0 };
    res.json({ ratee, scores, percentiles, top5, bottom5 });
  } catch (err) {
    console.error('Personal results error:', err.message);
    res.status(500).json({ error: 'Failed to get personal results' });
  }
});

module.exports = router;
