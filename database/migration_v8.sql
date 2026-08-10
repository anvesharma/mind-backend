-- ============================================================================
-- migration_v8.sql — rater reputation
--
-- Stores, per rater, how closely their assessments match the consensus of
-- everyone else who rated the same people. Scored 5.00 (completely off) to
-- 10.00 (exact match). See backend/src/reputation.js for the formula.
--
-- Internal only for now — no endpoint exposes it. Query it directly.
-- ============================================================================

-- ── Columns ─────────────────────────────────────────────────────────────────

ALTER TABLE users
  -- NULL means "not measurable yet": nobody else has rated anyone this person
  -- rated, so there is no consensus to compare against. Deliberately not the
  -- prior (8.50) — "unmeasured" must stay distinguishable from "measured at
  -- 8.50", and right now almost every rater is unmeasured.
  ADD COLUMN IF NOT EXISTS reputation_score NUMERIC(4,2),

  -- How many (rater, ratee) pairings the score is built from. Low counts are
  -- heavily shrunk toward the prior, so read the score alongside this.
  ADD COLUMN IF NOT EXISTS reputation_pairings INTEGER NOT NULL DEFAULT 0,

  ADD COLUMN IF NOT EXISTS reputation_updated_at TIMESTAMPTZ;

-- Guard the range at the database level. The application clamps, but a bad
-- backfill or a manual UPDATE should not be able to store a 3 or a 47.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_reputation_score_range'
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_reputation_score_range
      CHECK (reputation_score IS NULL OR (reputation_score >= 5 AND reputation_score <= 10));
  END IF;
END $$;

-- Finding the worst raters is the main query this table will serve.
CREATE INDEX IF NOT EXISTS idx_users_reputation
  ON users (reputation_score)
  WHERE reputation_score IS NOT NULL;


-- ── Backfill ────────────────────────────────────────────────────────────────
-- Reputation cannot be computed in SQL: it needs the weighted scoring and the
-- ethics penalty from src/scoring.js. Run the backfill script instead:
--
--   cd backend && npm run reputation:backfill
--
-- It is idempotent — safe to re-run at any time.


-- ── Queries ─────────────────────────────────────────────────────────────────

-- Everyone with a measurable reputation, worst first.
--
--   SELECT user_id, user_name, email,
--          reputation_score, reputation_pairings, reputation_updated_at
--   FROM users
--   WHERE reputation_score IS NOT NULL
--   ORDER BY reputation_score ASC;

-- Coverage — how much of the rater base is measurable at all.
--
--   SELECT
--     COUNT(*) FILTER (WHERE reputation_score IS NOT NULL) AS measured,
--     COUNT(*) FILTER (WHERE reputation_score IS NULL)     AS unmeasured,
--     ROUND(AVG(reputation_score), 2)                      AS avg_score,
--     ROUND(AVG(reputation_pairings), 1)                   AS avg_pairings
--   FROM users
--   WHERE user_id IN (SELECT DISTINCT add_user_id FROM user_responses);

-- Raters worth reviewing: a low score backed by enough pairings to trust it.
-- Below ~7 with 3+ pairings is noise, not signal.
--
--   SELECT user_id, user_name, reputation_score, reputation_pairings
--   FROM users
--   WHERE reputation_score < 7
--     AND reputation_pairings >= 3
--   ORDER BY reputation_score ASC;

-- Distribution, to sanity check the calibration once real data exists.
-- If everyone lands in one bucket, D_MAX in src/reputation.js needs retuning.
--
--   SELECT width_bucket(reputation_score, 5, 10, 10) AS bucket,
--          COUNT(*)
--   FROM users
--   WHERE reputation_score IS NOT NULL
--   GROUP BY bucket
--   ORDER BY bucket;
