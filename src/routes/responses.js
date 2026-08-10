const express = require('express');
const router = express.Router();
const db = require('../db');
const authenticate = require('../middleware/authenticate');
const scoring = require('../scoring');
const poolCache = require('../poolcache');
const reputationStore = require('../reputationstore');

// ── Shared queries ───────────────────────────────────────────────────────

/** Size of the question bank. A submission must answer all of them to score. */
async function getTotalQuestions() {
  const result = await db.query('SELECT COUNT(*)::int AS total FROM questions');
  return result.rows[0].total;
}

/**
 * Every response belonging to an (assessor, ratee) pair that answered the full
 * question bank. This is the ranking pool — all routes rank against it, so
 * Mind for Work and Mind for You draw percentiles from the same population.
 */
async function getCompletedResponses() {
  const result = await db.query(`
    WITH complete_pairs AS (
      SELECT user_id, add_user_id
      FROM user_responses
      GROUP BY user_id, add_user_id
      HAVING COUNT(DISTINCT question_id) >= (SELECT COUNT(*) FROM questions)
    )
    SELECT ur.user_id, ur.add_user_id, ur.question_id, ur.response_value,
           q.question_text, q.leader_weight, q.manager_weight, q.ic_weight
    FROM user_responses ur
    JOIN questions q ON ur.question_id = q.question_id
    JOIN complete_pairs cp
      ON cp.user_id = ur.user_id AND cp.add_user_id = ur.add_user_id
  `);
  return result.rows;
}

/** Responses about `rateeId`, optionally narrowed to a single assessor. */
async function getResponsesFor(rateeId, assessorId = null) {
  const params = assessorId ? [rateeId, assessorId] : [rateeId];
  const filter = assessorId ? 'AND ur.add_user_id = $2' : '';

  const result = await db.query(
    `SELECT ur.user_id, ur.add_user_id, ur.question_id, ur.response_value,
            q.question_text, q.leader_weight, q.manager_weight, q.ic_weight
     FROM user_responses ur
     JOIN questions q ON ur.question_id = q.question_id
     WHERE ur.user_id = $1 ${filter}`,
    params
  );
  return result.rows;
}

async function getRatee(rateeId) {
  const result = await db.query(
    'SELECT user_id, user_name FROM users WHERE user_id = $1',
    [rateeId]
  );
  return result.rows[0] || null;
}

/**
 * The one results handler. Every results route funnels through here so the
 * scale, the ethics penalty and the percentile pool can never diverge again.
 *
 * @param {string|number} rateeId
 * @param {string|number|null} assessorId  null = aggregate across all raters
 */
/**
 * The percentile pool, cached.
 *
 * Building it reads every completed response in the database, so doing it per
 * request made the results page take seconds — a refresh recomputed the entire
 * population to render one card. It only changes when a submission completes,
 * which invalidates the cache.
 */
async function getPercentilePool(totalQuestions) {
  const cached = poolCache.get(totalQuestions);
  if (cached) return cached;

  const pool = scoring.buildPool(await getCompletedResponses(), totalQuestions);
  return poolCache.set(pool, totalQuestions);
}

async function buildResults(rateeId, assessorId) {
  // Independent queries — issue them together rather than paying three
  // sequential round trips to the connection pooler before anything renders.
  const [ratee, rows, totalQuestions] = await Promise.all([
    getRatee(rateeId),
    getResponsesFor(rateeId, assessorId),
    getTotalQuestions(),
  ]);

  if (!ratee) return { error: 'User not found', status: 404 };
  if (!rows.length) return { error: 'No responses found', status: 404 };

  // One submission per rater; only fully answered ones count toward the score.
  const grouped = scoring.groupByRateeAndAssessor(rows);
  const submissions = Object.values(grouped[rateeId] || {}).map(scoring.scoreSubmission);
  const completed = submissions.filter((s) => scoring.isComplete(s, totalQuestions));

  if (!completed.length) {
    return {
      error: 'Assessment incomplete',
      status: 409,
      detail: {
        answered: Math.max(...submissions.map((s) => s.answered), 0),
        required: totalQuestions,
      },
    };
  }

  const aggregate = scoring.aggregateSubmissions(completed);
  const pool = await getPercentilePool(totalQuestions);
  const { top5, bottom5 } = scoring.attributeBreakdown(rows);

  return {
    body: {
      ratee,
      scores: scoring.formatScores(aggregate),
      percentiles: scoring.formatPercentiles(aggregate, pool),
      top5,
      bottom5,
      raters: aggregate.raters,
    },
  };
}

function send(res, result) {
  if (result.error) {
    return res.status(result.status).json({ error: result.error, ...result.detail });
  }
  return res.json(result.body);
}

// ── Saving responses ─────────────────────────────────────────────────────

// POST /api/responses — save one answer and advance the resume point.
// Partial submissions are stored so a rater can pick up where they left off;
// they simply do not count toward a score until the bank is complete.
router.post('/', authenticate, async (req, res) => {
  const { ratee_id, question_id, response_value } = req.body;
  const assessor_id = req.user.user_id;

  if (!ratee_id || !question_id || response_value === undefined) {
    return res
      .status(400)
      .json({ error: 'ratee_id, question_id and response_value are required' });
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
    console.error('Save response error:', err.message);
    res.status(500).json({ error: 'Failed to save response' });
  }
});

// POST /api/responses/complete
router.post('/complete', authenticate, async (req, res) => {
  const { ratee_id } = req.body;
  const assessor_id = req.user.user_id;

  try {
    await db.query(
      `UPDATE assessment_progress SET completed = true, updated_at = NOW()
       WHERE assessor_id = $1 AND ratee_id = $2`,
      [assessor_id, ratee_id]
    );

    // A new completed submission changes the ranking population.
    poolCache.invalidate();

    // Respond first. Reputation is an internal analytics figure — nothing in
    // this response depends on it, and the rater should not wait on a full
    // recomputation to see their results.
    res.json({ message: 'Assessment completed' });

    // Recompute for every rater of this ratee, not just this one: a new rater
    // shifts the leave-one-out consensus for all the others.
    reputationStore.recomputeForRatee(ratee_id).catch((err) => {
      console.error('Reputation recompute failed for ratee', ratee_id, err.message);
    });
  } catch (err) {
    console.error('Complete assessment error:', err.message);
    res.status(500).json({ error: 'Failed to complete assessment' });
  }
});

// GET /api/responses/progress/:ratee_id — resume state for this rater.
//
// The identity pair is (assessor_id from JWT, ratee_id).
//
// Returns the SET of question ids already answered, not a position. The
// question bank is served in random order, so a positional resume point is
// meaningless on the next visit: the same index lands on a different question.
// The client resumes by removing answered ids from the freshly shuffled bank.
router.get('/progress/:ratee_id', authenticate, async (req, res) => {
  const assessor_id = req.user.user_id;
  const { ratee_id } = req.params;

  try {
    const [progressResult, answeredResult, totalResult] = await Promise.all([
      db.query(
        `SELECT ap.started_at, ap.updated_at, ap.completed AS marked_completed,
                ap.last_question_id, q.question_text AS last_question_text
         FROM assessment_progress ap
         LEFT JOIN questions q ON ap.last_question_id = q.question_id
         WHERE ap.assessor_id = $1 AND ap.ratee_id = $2`,
        [assessor_id, ratee_id]
      ),
      db.query(
        `SELECT DISTINCT question_id
         FROM user_responses
         WHERE add_user_id = $1 AND user_id = $2`,
        [assessor_id, ratee_id]
      ),
      db.query('SELECT COUNT(*)::int AS total FROM questions'),
    ]);

    const answeredQuestionIds = answeredResult.rows.map((r) => r.question_id);
    const total = totalResult.rows[0].total;
    const answered = answeredQuestionIds.length;

    res.json({
      ...(progressResult.rows[0] || {}),
      answered_question_ids: answeredQuestionIds,
      answered,
      total,
      remaining: Math.max(total - answered, 0),
      // Derived from actual responses rather than the assessment_progress flag,
      // which only gets set if the rater reached the end in one sitting.
      completed: total > 0 && answered >= total,
      resuming: answered > 0 && answered < total,
    });
  } catch (err) {
    console.error('Get progress error:', err.message);
    res.status(500).json({ error: 'Failed to get progress' });
  }
});

// ── Results ──────────────────────────────────────────────────────────────

// GET /api/responses/results/:ratee_id — Mind for Work.
// What this rater alone reported about the ratee.
router.get('/results/:ratee_id', authenticate, async (req, res) => {
  try {
    send(res, await buildResults(req.params.ratee_id, req.user.user_id));
  } catch (err) {
    console.error('Results error:', err.message);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// GET /api/responses/personal-results/peer/:rateeId — aggregate across every
// peer who completed the assessment. No auth: reached via an emailed link.
// Declared before the /:rateeId route so "peer" is not read as an id.
router.get('/personal-results/peer/:rateeId', async (req, res) => {
  try {
    send(res, await buildResults(req.params.rateeId, null));
  } catch (err) {
    console.error('Peer results error:', err.message);
    res.status(500).json({ error: 'Failed to get results' });
  }
});

// GET /api/responses/personal-results/:rateeId — Mind for You.
// Same handler, same scale, same pool as Mind for Work.
router.get('/personal-results/:rateeId', authenticate, async (req, res) => {
  try {
    send(res, await buildResults(req.params.rateeId, req.user.user_id));
  } catch (err) {
    console.error('Personal results error:', err.message);
    res.status(500).json({ error: 'Failed to get personal results' });
  }
});

module.exports = router;
