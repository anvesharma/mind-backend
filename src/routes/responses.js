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

function computeScoresFromRows(rows) {
  let lw = 0, mw = 0, iw = 0;
  let lv = 0, mv = 0, iv = 0;
  let ethical = 10;

  rows.forEach(r => {
    const v  = parseFloat(r.response_value);
    const Lw = parseFloat(r.leader_weight)  || 0;
    const Mw = parseFloat(r.manager_weight) || 0;
    const Iw = parseFloat(r.ic_weight)      || 0;
    lw += Lw; mw += Mw; iw += Iw;
    lv += v * Lw; mv += v * Mw; iv += v * Iw;
    if (r.question_text === 'Ethical Behaviour') ethical = v;
  });

  const norm = (sumVW, sumW) => {
    if (!sumW) return null;
    const avg = sumVW / sumW;
    return 7 + ((avg - 1) / 9) * 3;
  };

  const Y = (10 - ethical) / 10;
  const leaderPenalty  = 1.5 * Y;
  const managerPenalty = 1.0 * Y;
  const icPenalty      = 0.75 * Y;

  let leader  = norm(lv, lw);
  let manager = norm(mv, mw);
  let ic      = norm(iv, iw);

  if (leader  !== null) leader  = leader  - leaderPenalty;
  if (manager !== null) manager = manager - managerPenalty;
  if (ic      !== null) ic      = ic      - icPenalty;

  return { leader, manager, ic };
}

router.get('/results/:ratee_id', authenticate, async (req, res) => {
  const { ratee_id } = req.params;

  try {
    const myRows = await db.query(
      `SELECT ur.response_value, ur.add_user_id, q.question_text,
              q.leader_weight, q.manager_weight, q.ic_weight
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id
       WHERE ur.user_id = $1 AND ur.add_user_id = $2`,
      [ratee_id, req.user.user_id]
    );

    if (!myRows.rows.length) {
      return res.status(404).json({ error: 'No responses found' });
    }

    const myScores = computeScoresFromRows(myRows.rows);
    const scores = {
      leader_score:  myScores.leader  !== null ? parseFloat(myScores.leader.toFixed(2))  : null,
      manager_score: myScores.manager !== null ? parseFloat(myScores.manager.toFixed(2)) : null,
      ic_score:      myScores.ic      !== null ? parseFloat(myScores.ic.toFixed(2))      : null,
    };

    const allRows = await db.query(
      `SELECT ur.user_id, ur.add_user_id, ur.response_value, q.question_text,
              q.leader_weight, q.manager_weight, q.ic_weight
       FROM user_responses ur
       JOIN questions q ON ur.question_id = q.question_id`
    );

    const byPerson = {};
    allRows.rows.forEach(r => {
      const p = r.user_id, a = r.add_user_id;
      byPerson[p] = byPerson[p] || {};
      byPerson[p][a] = byPerson[p][a] || [];
      byPerson[p][a].push(r);
    });

    const personScores = {};
    Object.keys(byPerson).forEach(p => {
      const assessors = Object.values(byPerson[p]);
      const perAssessor = assessors.map(rows => computeScoresFromRows(rows));
      const avg = (key) => {
        const vals = perAssessor.map(s => s[key]).filter(v => v !== null);
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
      const leader = avg('leader'), manager = avg('manager'), ic = avg('ic');
      const parts = [leader, manager, ic].filter(v => v !== null);
      const overall = parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
      personScores[p] = { leader, manager, ic, overall };
    });

    const pctRank = (targetVal, key) => {
      if (targetVal === null || targetVal === undefined) return 0;
      const all = Object.values(personScores).map(s => s[key]).filter(v => v !== null);
      if (all.length <= 1) return 100;
      const below = all.filter(v => v < targetVal).length;
      return Math.round((below / (all.length - 1)) * 100);
    };

    const me = personScores[ratee_id] || { leader: null, manager: null, ic: null, overall: null };
    const percentiles = {
      leader_percentile:  pctRank(me.leader,  'leader'),
      manager_percentile: pctRank(me.manager, 'manager'),
      ic_percentile:      pctRank(me.ic,      'ic'),
      total_percentile:   pctRank(me.overall, 'overall'),
    };

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
