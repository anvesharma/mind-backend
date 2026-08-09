-- ============================================================================
-- checks_v6_single.sql
--
-- Same diagnostics as checks_v6.sql, collapsed into ONE query so Supabase
-- returns all of it in a single result grid. Read-only. Run it, screenshot or
-- paste the whole grid.
-- ============================================================================

WITH checks AS (

  -- 1. The constraint the ON CONFLICT upsert depends on. Detected by columns,
  --    so a dashboard-assigned name still shows up.
  SELECT 1 AS ord,
         'unique constraint on user_responses' AS check_name,
         COALESCE((
           SELECT string_agg(con.conname || '  ->  ' || pg_get_constraintdef(con.oid), '   |   ')
           FROM pg_constraint con
           JOIN pg_class rel ON rel.oid = con.conrelid
           WHERE rel.relname = 'user_responses'
             AND con.contype IN ('u', 'p')
         ), '*** NONE — every response save is throwing ***') AS result

  -- 2. A bare unique index also satisfies ON CONFLICT, with no constraint object.
  UNION ALL
  SELECT 2,
         'unique indexes on user_responses',
         COALESCE((
           SELECT string_agg(indexname, '   |   ')
           FROM pg_indexes
           WHERE tablename = 'user_responses'
             AND indexdef ILIKE '%UNIQUE%'
         ), 'none')

  -- 3-4. Duplicates would block ADD CONSTRAINT. Expect zero.
  UNION ALL
  SELECT 3,
         'duplicate (ratee, question, rater) triples',
         (SELECT COUNT(*)::text FROM (
            SELECT 1 FROM user_responses
            GROUP BY user_id, question_id, add_user_id
            HAVING COUNT(*) > 1
          ) d)

  UNION ALL
  SELECT 4,
         'rows the dedupe would delete',
         COALESCE((SELECT SUM(extra)::text FROM (
            SELECT COUNT(*) - 1 AS extra FROM user_responses
            GROUP BY user_id, question_id, add_user_id
            HAVING COUNT(*) > 1
          ) d), '0')

  -- 5-8. Did migration_v4 / v5 actually land?
  UNION ALL
  SELECT 5,
         'question count (expect 33)',
         (SELECT COUNT(*)::text FROM questions)

  UNION ALL
  SELECT 6,
         'Ethical Behaviour weights L/M/IC (expect 0/0/0)',
         COALESCE((
           SELECT leader_weight || ' / ' || manager_weight || ' / ' || ic_weight
           FROM questions WHERE question_text = 'Ethical Behaviour' LIMIT 1
         ), '*** ROW MISSING ***')

  UNION ALL
  SELECT 7,
         'weight totals L/M/IC',
         (SELECT ROUND(SUM(leader_weight), 4) || ' / ' ||
                 ROUND(SUM(manager_weight), 4) || ' / ' ||
                 ROUND(SUM(ic_weight), 4)
          FROM questions)

  UNION ALL
  SELECT 8,
         'attributes with zero weight everywhere (expect 1)',
         (SELECT COUNT(*)::text FROM questions
          WHERE COALESCE(leader_weight, 0) = 0
            AND COALESCE(manager_weight, 0) = 0
            AND COALESCE(ic_weight, 0) = 0)

  -- 9-12. Blast radius of the completion gate.
  UNION ALL
  SELECT 9,
         'submissions COMPLETE (all 33 answered)',
         (SELECT COUNT(*)::text FROM (
            SELECT user_id FROM user_responses
            GROUP BY user_id, add_user_id
            HAVING COUNT(DISTINCT question_id) >= (SELECT COUNT(*) FROM questions)
          ) s)

  UNION ALL
  SELECT 10,
         'submissions PARTIAL (will stop scoring)',
         (SELECT COUNT(*)::text FROM (
            SELECT user_id FROM user_responses
            GROUP BY user_id, add_user_id
            HAVING COUNT(DISTINCT question_id) < (SELECT COUNT(*) FROM questions)
          ) s)

  UNION ALL
  SELECT 11,
         'ratees with a score = percentile pool size',
         (SELECT COUNT(DISTINCT user_id)::text FROM (
            SELECT user_id, add_user_id FROM user_responses
            GROUP BY user_id, add_user_id
            HAVING COUNT(DISTINCT question_id) >= (SELECT COUNT(*) FROM questions)
          ) s)

  -- 12. Multi-rater coverage. This is the number the reputation score needs:
  --     one-vote-per-rater aggregation only means something above 1 rater.
  UNION ALL
  SELECT 12,
         'ratees with 2+ complete raters',
         (SELECT COUNT(*)::text FROM (
            SELECT user_id FROM (
              SELECT user_id, add_user_id FROM user_responses
              GROUP BY user_id, add_user_id
              HAVING COUNT(DISTINCT question_id) >= (SELECT COUNT(*) FROM questions)
            ) c
            GROUP BY user_id
            HAVING COUNT(*) > 1
          ) m)

  -- 13. How many raters are guests. Guests get a fresh identity per login, so
  --     this is the share of the pool that can be repeated at will.
  UNION ALL
  SELECT 13,
         'complete submissions from guest raters',
         (SELECT COUNT(*)::text FROM (
            SELECT ur.user_id, ur.add_user_id
            FROM user_responses ur
            JOIN users u ON u.user_id = ur.add_user_id
            WHERE COALESCE(u.real_email, FALSE) = FALSE
            GROUP BY ur.user_id, ur.add_user_id
            HAVING COUNT(DISTINCT ur.question_id) >= (SELECT COUNT(*) FROM questions)
          ) g)

)
SELECT check_name, result
FROM checks
ORDER BY ord;
