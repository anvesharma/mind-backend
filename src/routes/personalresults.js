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
      SELECT ur.response_value, ur.add_user_id, q.question_text,
        q.leader_weight, q.manager_weight, q.ic_weight
      FROM user_responses ur
      JOIN questions q ON ur.question_id = q.question_id
      WHERE ur.user_id = $1
    `, [rateeId]);

    const responses = responsesRes.rows;
    if (!responses.length) return res.status(404).json({ error: 'No responses found' });

    const raterMap = {};
    responses.forEach(r => {
      const rid = r.add_user_id;
      if (!raterMap[rid]) raterMap[rid] = [];
      raterMap[rid].push(r);
    });

    const raterScores = Object.values(raterMap).map(rr => {
      const ls = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.leader_weight)||0), 0);
      const ms = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.manager_weight)||0), 0);
      const ics = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.ic_weight)||0), 0);
      return { ls: 7 + (ls / 100) * 3, ms: 7 + (ms / 100) * 3, ics: 7 + (ics / 100) * 3 };
    });

    const n = raterScores.length;
    const scores = {
      leader_score: parseFloat((raterScores.reduce((s, r) => s + r.ls, 0) / n).toFixed(2)),
      manager_score: parseFloat((raterScores.reduce((s, r) => s + r.ms, 0) / n).toFixed(2)),
      ic_score: parseFloat((raterScores.reduce((s, r) => s + r.ics, 0) / n).toFixed(2)),
    };

    const attrMap = {};
    responses.forEach(r => {
      if (!attrMap[r.question_text]) attrMap[r.question_text] = { name: r.question_text, values: [], lw: parseFloat(r.leader_weight)||0, mw: parseFloat(r.manager_weight)||0, iw: parseFloat(r.ic_weight)||0 };
      attrMap[r.question_text].values.push(parseFloat(r.response_value));
    });
    Object.values(attrMap).forEach(a => {
      a.value = a.values.reduce((s, v) => s + v, 0) / a.values.length;
      a.total_weight = a.lw + a.mw + a.iw;
    });

    const sorted = Object.values(attrMap).sort((a, b) =>
      b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight
    );
    const top5 = sorted.slice(0, 5).map(a => ({ name: a.name, value: parseFloat(a.value.toFixed(2)) }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: parseFloat(a.value.toFixed(2)) }));

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

    const ls = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.leader_weight)||0), 0);
    const ms = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.manager_weight)||0), 0);
    const ics = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.ic_weight)||0), 0);

    const scores = {
      leader_score: parseFloat((7 + (ls / 100) * 3).toFixed(2)),
      manager_score: parseFloat((7 + (ms / 100) * 3).toFixed(2)),
      ic_score: parseFloat((7 + (ics / 100) * 3).toFixed(2)),
    };

    const attrMap = {};
    responses.forEach(r => {
      if (!attrMap[r.question_text]) attrMap[r.question_text] = { name: r.question_text, value: parseFloat(r.response_value), total_weight: (parseFloat(r.leader_weight)||0)+(parseFloat(r.manager_weight)||0)+(parseFloat(r.ic_weight)||0) };
    });

    const sorted = Object.values(attrMap).sort((a, b) =>
      b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight
    );
    const top5 = sorted.slice(0, 5).map(a => ({ name: a.name, value: a.value }));
    const bottom5 = sorted.slice(-5).reverse().map(a => ({ name: a.name, value: a.value }));

    const percentileRes = await db.query(`
      WITH all_scores AS (
        SELECT ur.user_id, ur.add_user_id,
          7 + (SUM(ur.response_value * q.leader_weight) / 100) * 3 AS ls,
          7 + (SUM(ur.response_value * q.manager_weight) / 100) * 3 AS ms,
          7 + (SUM(ur.response_value * q.ic_weight) / 100) * 3 AS ics
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
