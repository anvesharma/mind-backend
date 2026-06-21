const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');

// Normalize 1–10 weighted avg to 7–10 scale
function normalize(weightedSum, totalWeight) {
  if (!totalWeight) return 7.00;
  const avg = weightedSum / totalWeight;
  return 7 + ((avg - 1) / 9) * 3;
}

// Ethical Behaviour penalty: Y = (10 - x) / 10
// Leader penalty = 1.5Y, Manager penalty = 1.0Y, IC penalty = 0.75Y
function ethicalPenalties(rating) {
  const Y = (10 - parseFloat(rating)) / 10;
  return { leaderPenalty: 1.5 * Y, managerPenalty: 1.0 * Y, icPenalty: 0.75 * Y };
}

// ── Peer route (no auth) ────────────────────────────────────────────────
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

    // Group by rater
    const raterMap = {};
    responses.forEach(r => {
      const rid = r.add_user_id;
      if (!raterMap[rid]) raterMap[rid] = [];
      raterMap[rid].push(r);
    });

    const raterScores = Object.values(raterMap).map(rr => {
      const lSum = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.leader_weight)  || 0), 0);
      const mSum = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.manager_weight) || 0), 0);
      const iSum = rr.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.ic_weight)      || 0), 0);
      const lW   = rr.reduce((s, r) => s + (parseFloat(r.leader_weight)  || 0), 0);
      const mW   = rr.reduce((s, r) => s + (parseFloat(r.manager_weight) || 0), 0);
      const iW   = rr.reduce((s, r) => s + (parseFloat(r.ic_weight)      || 0), 0);

      // Get this rater's Ethical Behaviour rating
      const ethRow = rr.find(r => r.question_text === 'Ethical Behaviour');
      const { leaderPenalty, managerPenalty, icPenalty } = ethRow ? ethicalPenalties(ethRow.response_value) : { leaderPenalty: 0, managerPenalty: 0, icPenalty: 0 };

      return {
        ls:  normalize(lSum, lW) - leaderPenalty,
        ms:  normalize(mSum, mW) - managerPenalty,
        ics: normalize(iSum, iW) - icPenalty,
      };
    });

    const n = raterScores.length;
    const scores = {
      leader_score:  parseFloat((raterScores.reduce((s, r) => s + r.ls,  0) / n).toFixed(2)),
      manager_score: parseFloat((raterScores.reduce((s, r) => s + r.ms,  0) / n).toFixed(2)),
      ic_score:      parseFloat((raterScores.reduce((s, r) => s + r.ics, 0) / n).toFixed(2)),
    };

    // Top/bottom attributes by avg response value across raters
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

    // Exclude Ethical Behaviour from top/bottom lists
    const sorted = Object.values(attrMap)
      .filter(a => a.name !== 'Ethical Behaviour')
      .sort((a, b) => b.value !== a.value ? b.value - a.value : b.total_weight - a.total_weight);

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

    // Get Ethical Behaviour rating
    const ethRow = responses.find(r => r.question_text === 'Ethical Behaviour');
    const { leaderPenalty, managerPenalty, icPenalty } = ethRow ? ethicalPenalties(ethRow.response_value) : { leaderPenalty: 0, managerPenalty: 0, icPenalty: 0 };

    // Weighted average per dimension
    const lSum = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.leader_weight)  || 0), 0);
    const mSum = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.manager_weight) || 0), 0);
    const iSum = responses.reduce((s, r) => s + parseFloat(r.response_value) * (parseFloat(r.ic_weight)      || 0), 0);
    const lW   = responses.reduce((s, r) => s + (parseFloat(r.leader_weight)  || 0), 0);
    const mW   = responses.reduce((s, r) => s + (parseFloat(r.manager_weight) || 0), 0);
    const iW   = responses.reduce((s, r) => s + (parseFloat(r.ic_weight)      || 0), 0);

    const scores = {
      leader_score:  parseFloat((normalize(lSum, lW) - leaderPenalty).toFixed(2)),
      manager_score: parseFloat((normalize(mSum, mW) - managerPenalty).toFixed(2)),
      ic_score:      parseFloat((normalize(iSum, iW) - icPenalty).toFixed(2)),
    };

    // Top/bottom attributes — exclude Ethical Behaviour
    const attrMap = {};
    responses
      .filter(r => r.question_text !== 'Ethical Behaviour')
      .forEach(r => {
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

    // Percentile — average per assessor first, then average across assessors per user
    const percentileRes = await db.query(`
      WITH per_assessor AS (
        SELECT
          ur.user_id,
          ur.add_user_id,
          SUM(ur.response_value * q.leader_weight)  / NULLIF(SUM(q.leader_weight),  0) AS l_avg,
          SUM(ur.response_value * q.manager_weight) / NULLIF(SUM(q.manager_weight), 0) AS m_avg,
          SUM(ur.response_value * q.ic_weight)      / NULLIF(SUM(q.ic_weight),      0) AS i_avg
        FROM user_responses ur
        JOIN questions q ON ur.question_id = q.question_id
        GROUP BY ur.user_id, ur.add_user_id
      ),
      user_scores AS (
        SELECT
          user_id,
          AVG(l_avg) AS l_avg,
          AVG(m_avg) AS m_avg,
          AVG(i_avg) AS i_avg
        FROM per_assessor
        GROUP BY user_id
      ),
      ranked AS (
        SELECT user_id,
          ROUND(CAST(PERCENT_RANK() OVER (ORDER BY (l_avg + m_avg + i_avg) / 3) * 100 AS numeric), 0) AS total_pct
        FROM user_scores
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
