-- ============================================================================
-- migration_v7.sql — attribute weights (source of truth)
--
-- The scoring model has never been in version control. This file IS the model:
-- run it and the questions table matches the documented weights exactly.
--
-- Column totals: Leader 265, Manager 186, IC 55.
--
-- Weights are raw integers, not decimals summing to 1.0. That is fine — every
-- formula in scoring.js divides by the weight sum, so scale cancels out. Only
-- the ratio between attributes within a column matters.
--
-- Ethical Behaviour carries zero weight. It is applied as a penalty in
-- scoring.js:  Y = (10 - X) / 10, where X is the peer's ethics rating, then
--   Leader  -= 1.5  * Y
--   Manager -= 1.0  * Y
--   IC      -= 0.75 * Y
-- with a floor of 5.00.
-- ============================================================================

WITH intended (attribute, leader, manager, ic) AS (VALUES
  ('Courage',            10, 0,  0),
  ('Vision',             10, 0,  0),
  ('Adaptability',        9, 6,  2),
  ('Listening',           9, 9,  0),
  ('Resilience',          9, 5,  2),
  ('Humility',            7, 5,  0),
  ('Communication',       7, 9,  0),
  ('Ethical Behaviour',   0, 0,  0),
  ('Creativity',          0, 0,  1),
  ('Empathy',             8, 5,  0),
  ('Execution',           9, 6,  3),
  ('Confidence',          8, 6,  2),
  ('Self Awareness',      9, 6,  0),
  ('Ownership',          10, 7,  5),
  ('Negotiation',         7, 5,  0),
  ('Trustworthiness',    10, 10, 3),
  ('Critical Thinking',   7, 5,  5),
  ('Storytelling',        9, 3,  0),
  ('Curiosity',           6, 3,  1),
  ('Problem Solving',     8, 8,  8),
  ('Planning',            7, 7,  1),
  ('Consistency',         9, 7,  4),
  ('Accountability',      9, 7,  4),
  ('Judgement',          10, 8,  5),
  ('Discipline',          9, 8,  4),
  ('Time Management',     9, 7,  2),
  ('Coordination',        6, 9,  0),
  ('Strategic Thinking', 10, 5,  0),
  ('Decision Making',    10, 7,  3),
  ('Influence',           8, 3,  0),
  ('Inspiration',        10, 0,  0),
  ('Coaching',            6, 10, 0),
  ('Collaboration',      10, 10, 0)
)
UPDATE questions q
SET leader_weight  = i.leader,
    manager_weight = i.manager,
    ic_weight      = i.ic
FROM intended i
WHERE q.question_text = i.attribute;


-- ── Verify ──────────────────────────────────────────────────────────────────
-- Expect: 33 | 265 | 186 | 55
--
--   SELECT COUNT(*)            AS question_count,
--          SUM(leader_weight)  AS leader_total,
--          SUM(manager_weight) AS manager_total,
--          SUM(ic_weight)      AS ic_total
--   FROM questions;
--
-- If ic_total is not 55, an attribute name in the table does not match one
-- above, so that row kept its old weights. Find it with:
--
--   SELECT question_id, question_text FROM questions ORDER BY question_id;
