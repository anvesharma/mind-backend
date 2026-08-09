-- ============================================================================
-- checks_v6.sql — run these in the Supabase SQL editor BEFORE migration_v6.
-- Read-only. Paste the output back so the migration can be applied safely.
-- ============================================================================


-- ── 1. Does the upsert constraint exist, under any name? ────────────────────
-- routes/responses.js relies on ON CONFLICT (user_id, question_id, add_user_id).
-- Expect exactly one row covering those three columns. Zero rows means every
-- response save is currently throwing.
SELECT con.conname AS constraint_name,
       pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relname = 'user_responses'
  AND con.contype IN ('u', 'p');

-- Unique constraints can also be backed by a bare unique index with no
-- constraint object. This catches that case.
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'user_responses';


-- ── 2. Are there duplicates that would block adding it? ─────────────────────
-- Expect 0 rows. Anything here must be collapsed first; migration_v6 does that
-- automatically, keeping the highest response_id (most recent) per triple.
SELECT user_id, question_id, add_user_id, COUNT(*) AS copies
FROM user_responses
GROUP BY user_id, question_id, add_user_id
HAVING COUNT(*) > 1
ORDER BY copies DESC
LIMIT 20;

-- How many rows the dedupe would remove.
SELECT COUNT(*) AS rows_to_delete
FROM (
  SELECT user_id, question_id, add_user_id, COUNT(*) - 1 AS extra
  FROM user_responses
  GROUP BY user_id, question_id, add_user_id
  HAVING COUNT(*) > 1
) d;


-- ── 3. Did migration_v4 / v5 actually land? ─────────────────────────────────
-- Expect 33. scoring.js gates completion on this number.
SELECT COUNT(*) AS question_count FROM questions;

-- Expect exactly one row, with all three weights at 0.
SELECT question_id, question_text, leader_weight, manager_weight, ic_weight
FROM questions
WHERE question_text = 'Ethical Behaviour';

-- Per-dimension weight totals. These are the denominators in every score.
SELECT SUM(leader_weight)  AS leader_total,
       SUM(manager_weight) AS manager_total,
       SUM(ic_weight)      AS ic_total
FROM questions;

-- Any attribute with zero weight across all three dimensions is dead weight in
-- the assessment: raters answer it and it affects nothing. Ethical Behaviour is
-- the only row that should appear here.
SELECT question_id, question_text
FROM questions
WHERE COALESCE(leader_weight, 0) = 0
  AND COALESCE(manager_weight, 0) = 0
  AND COALESCE(ic_weight, 0) = 0;


-- ── 4. How much data survives the completion gate? ──────────────────────────
-- Scores now require all 33 answers. This is the blast radius: how many
-- (ratee, rater) pairs currently qualify, and how many are stranded partials.
SELECT CASE
         WHEN answered >= (SELECT COUNT(*) FROM questions) THEN 'complete'
         ELSE 'partial'
       END AS status,
       COUNT(*) AS submissions
FROM (
  SELECT user_id, add_user_id, COUNT(DISTINCT question_id) AS answered
  FROM user_responses
  GROUP BY user_id, add_user_id
) s
GROUP BY 1;

-- How many distinct people will have a score at all — this is your percentile
-- pool size. If it is small, percentiles will look extreme (0 or 100).
SELECT COUNT(DISTINCT user_id) AS ratees_with_a_score
FROM (
  SELECT user_id, add_user_id, COUNT(DISTINCT question_id) AS answered
  FROM user_responses
  GROUP BY user_id, add_user_id
) s
WHERE answered >= (SELECT COUNT(*) FROM questions);
