const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

router.get('/peer/:rateeId', async (req, res) => {
  const { rateeId } = req.params;
  try {
    const rateeRes = await db.query('SELECT user_id, user_name FROM users WHERE user_id = $1', [rateeId]);
    if (!rateeRes.rows.length) return res.status(404).json({ error: 'User not found' });
    const ratee = rateeRes.rows[0];

    const responsesRes = await db.query(`
      SELECT ur.response_value, q.question_text,
        q.leader_weight, q.manager_weight, q.ic_weight
      FROM user_responses ur
      JOIN questions q ON ur.question_id = q.question_id
      WHERE ur.user_id = $1
    `, [rateeId]);

    const responses = responsesRes.rows;
    if (!responses.length) return res.status(404).json({ error: 'No responses found' });

    const attributeMap = {};
    responses.forEach(r => {
      const name = r.question_text;
      if (!attributeMap[name]) attributeMap[name] = { name, values: [], lw: parseFloat(r.leader_weight)||0, mw: parseFloat(r.manager_weight)||0, iw: parseFloat(r.ic_weight)||0 };
      attributeMap[name].values.push(parseFloat(r.response_value));
    });

    Object.values(attributeMap).forEach(a => {
      a.value = a.values.reduce((s, v) => s + v, 0) / a.values.length;
      a.total_weight = a.lw + a.mw + a.iw;
    });

    const sorted = Object.values(attributeMap).sort((a, b) =>
      b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight
    );

    const top5 = sorted.slice(0, 5).map(a => ({ name: a.name, value: a.value }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: a.value }));

    // Correct scoring: average response per question weighted by question weight
    const attrs = Object.values(attributeMap);
    const leaderScore = 7 + attrs.reduce((s, a) => s + (a.value * a.lw), 0) * 10 * 3;
    const managerScore = 7 + attrs.reduce((s, a) => s + (a.value * a.mw), 0) * 10 * 3;
    const icScore = 7 + attrs.reduce((s, a) => s + (a.value * a.iw), 0) * 10 * 3;

    const scores = {
      leader_score: Math.min(10, parseFloat(leaderScore.toFixed(2))),
      manager_score: Math.min(10, parseFloat(managerScore.toFixed(2))),
      ic_score: Math.min(10, parseFloat(icScore.toFixed(2))),
    };

    res.json({ ratee, scores, percentiles: { total_pct: 0 }, top5, bottom5 });
  } catch (err) {
    console.error('Peer results error:', err.message);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

router.get('/:rateeId', authenticate, async (req, res) => {
  const { rateeId } = req.params;
  const assessorId = req.user.user_id;
  try {
    const rateeRes = await db.query('SELECT user_id, user_name FROM users WHERE user_id = $1', [rateeId]);
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

    const attributeMap = {};
    responses.forEach(r => {
      const name = r.question_text;
      if (!attributeMap[name]) attributeMap[name] = { name, value: parseFloat(r.response_value), lw: parseFloat(r.leader_weight)||0, mw: parseFloat(r.manager_weight)||0, iw: parseFloat(r.ic_weight)||0, total_weight: (parseFloat(r.leader_weight)||0)+(parseFloat(r.manager_weight)||0)+(parseFloat(r.ic_weight)||0) };
    });

    const sorted = Object.values(attributeMap).sort((a, b) =>
      b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight
    );

    const top5 = sorted.slice(0, 5).map(a => ({ name: a.name, value: a.value }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: a.value }));

    const attrs = Object.values(attributeMap);
    const leaderScore = 7 + attrs.reduce((s, a) => s + (a.value * a.lw), 0) * 10 * 3;
    const managerScore = 7 + attrs.reduce((s, a) => s + (a.value * a.mw), 0) * 10 * 3;
    const icScore = 7 + attrs.reduce((s, a) => s + (a.value * a.iw), 0) * 10 * 3;

    const scores = {
      leader_score: Math.min(10, parseFloat(leaderScore.toFixed(2))),
      manager_score: Math.min(10, parseFloat(managerScore.toFixed(2))),
      ic_score: Math.min(10, parseFloat(icScore.toFixed(2))),
    };

    const percentileRes = await db.query(`
      WITH all_scores AS (
        SELECT ur.user_id,
          7 + (SUM(ur.response_value * q.leader_weight) * 10 / 100) * 3 AS ls,
          7 + (SUM(ur.response_value * q.manager_weight) * 10 / 100) * 3 AS ms,
          7 + (SUM(ur.response_value * q.ic_weight) * 10 / 100) * 3 AS ics
        FROM user_responses ur JOIN questions q ON ur.question_id = q.question_id
        GROUP BY ur.user_id, ur.add_user_id
      ),
      ranked AS (
        SELECT user_id,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (ls+ms+ics)/3) * 100 AS numeric), 0) AS total_pct
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
