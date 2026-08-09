-- ============================================================================
-- migration_v6.sql — scoring consolidation support
--
-- Context: migration_v4 and migration_v5 were applied directly in Supabase and
-- never committed, so this repo cannot reproduce production. This migration is
-- written to be safe to run against a database that may or may not already
-- have these objects.
--
-- Run against BOTH your local mind_local database and Supabase.
-- ============================================================================


-- ── 1. Unique constraint backing the response upsert ────────────────────────
-- routes/responses.js does:
--     ON CONFLICT (user_id, question_id, add_user_id) DO UPDATE ...
-- Postgres requires a matching unique constraint or index. Without it that
-- INSERT throws:
--     there is no unique or exclusion constraint matching the ON CONFLICT
--     specification
-- No committed migration ever created it.

-- Collapse any duplicate rows first, keeping the most recent response.
DELETE FROM user_responses a
USING user_responses b
WHERE a.user_id      = b.user_id
  AND a.question_id  = b.question_id
  AND a.add_user_id  = b.add_user_id
  AND a.response_id  < b.response_id;

-- Detect the constraint by the COLUMNS it covers, not by its name. If it was
-- added by hand in Supabase it will have whatever name the dashboard assigned,
-- and a name-based check would miss it and then fail trying to add a duplicate.
DO $$
DECLARE
  already_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relname   = 'user_responses'
      AND i.indisunique
      AND i.indpred IS NULL          -- not a partial index
      AND i.indexprs IS NULL         -- not an expression index
      AND i.indnatts = 3
      -- attname is type `name`, so cast to text before comparing to a text[]
      AND (
        SELECT array_agg(a.attname::text ORDER BY a.attname::text)
        FROM unnest(i.indkey::smallint[]) AS k(attnum)
        JOIN pg_attribute a
          ON a.attrelid = c.oid AND a.attnum = k.attnum
      ) = ARRAY['add_user_id', 'question_id', 'user_id']::text[]
  ) INTO already_exists;

  IF already_exists THEN
    RAISE NOTICE 'Unique constraint on (user_id, question_id, add_user_id) already present - skipping.';
  ELSE
    ALTER TABLE user_responses
      ADD CONSTRAINT user_responses_unique_rating
      UNIQUE (user_id, question_id, add_user_id);
    RAISE NOTICE 'Added user_responses_unique_rating.';
  END IF;
END $$;


-- ── 2. Indexes for the scoring queries ──────────────────────────────────────
-- buildPool() scans every completed response on each results request. These
-- keep that from degrading as the pool grows.

CREATE INDEX IF NOT EXISTS idx_user_responses_ratee
  ON user_responses (user_id);

CREATE INDEX IF NOT EXISTS idx_user_responses_pair
  ON user_responses (user_id, add_user_id);


-- ── 3. Sanity checks ────────────────────────────────────────────────────────
-- Ethical Behaviour must carry zero weight in all three dimensions. It is
-- applied as a penalty in scoring.js, not as a weighted attribute. If this
-- returns a row, migration_v4/v5 did not fully apply.
--
--   SELECT question_id, question_text, leader_weight, manager_weight, ic_weight
--   FROM questions
--   WHERE question_text = 'Ethical Behaviour'
--     AND (leader_weight <> 0 OR manager_weight <> 0 OR ic_weight <> 0);
--
-- Question bank size — scoring gates completion on this count:
--
--   SELECT COUNT(*) FROM questions;   -- expect 33
--
-- Per-dimension weight totals — expect 265 / 186 / 55 after migration_v7:
--
--   SELECT SUM(leader_weight)  AS leader,
--          SUM(manager_weight) AS manager,
--          SUM(ic_weight)      AS ic
--   FROM questions;


-- ── 4. Weights ──────────────────────────────────────────────────────────────
-- Superseded by migration_v7.sql, which writes every weight explicitly and
-- serves as the committed snapshot of the scoring model. Run v7 after this.
