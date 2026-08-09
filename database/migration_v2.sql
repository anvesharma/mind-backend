-- ============================================================
-- Discover Mind — Database Migration v2
-- Date: 2026-06-06
-- ============================================================

BEGIN;

ALTER TABLE public.questions RENAME COLUMN leadership_weight TO leader_weight;
ALTER TABLE public.questions RENAME COLUMN management_weight TO manager_weight;
ALTER TABLE public.questions RENAME COLUMN cognitive_weight TO ic_weight;

ALTER TABLE public.questions
  ALTER COLUMN leader_weight  TYPE numeric(6,4) USING leader_weight::numeric(6,4),
  ALTER COLUMN manager_weight TYPE numeric(6,4) USING manager_weight::numeric(6,4),
  ALTER COLUMN ic_weight      TYPE numeric(6,4) USING ic_weight::numeric(6,4);

UPDATE public.questions SET question_text = 'Trustworthiness' WHERE question_text = 'Trust';

DELETE FROM public.user_responses WHERE question_id = (SELECT question_id FROM public.questions WHERE question_text = 'Determination');
DELETE FROM public.user_responses WHERE question_id = (SELECT question_id FROM public.questions WHERE question_text = 'Analytical Thinking');
DELETE FROM public.questions WHERE question_text = 'Determination';
DELETE FROM public.questions WHERE question_text = 'Analytical Thinking';

UPDATE public.questions SET leader_weight = 0.0364, manager_weight = 0.0114, ic_weight = 0.0000 WHERE question_text = 'Courage';
UPDATE public.questions SET leader_weight = 0.0455, manager_weight = 0.0000, ic_weight = 0.0000 WHERE question_text = 'Vision';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Adaptability';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0455, ic_weight = 0.0000 WHERE question_text = 'Listening';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0227, ic_weight = 0.0000 WHERE question_text = 'Resilience';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0114, ic_weight = 0.0000 WHERE question_text = 'Humility';
UPDATE public.questions SET leader_weight = 0.0364, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Communication';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Interpersonal Skills';
UPDATE public.questions SET leader_weight = 0.0364, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Integrity';
UPDATE public.questions SET leader_weight = 0.0364, manager_weight = 0.0227, ic_weight = 0.0000 WHERE question_text = 'Ethical behaviour';
UPDATE public.questions SET leader_weight = 0.0182, manager_weight = 0.0000, ic_weight = 0.1250 WHERE question_text = 'Creativity';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0114, ic_weight = 0.0000 WHERE question_text = 'Compassion';
UPDATE public.questions SET leader_weight = 0.0182, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Execution';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0227, ic_weight = 0.0000 WHERE question_text = 'Confidence';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0227, ic_weight = 0.0000 WHERE question_text = 'Awareness';
UPDATE public.questions SET leader_weight = 0.0455, manager_weight = 0.0568, ic_weight = 0.0417 WHERE question_text = 'Ownership';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0455, ic_weight = 0.0000 WHERE question_text = 'Negotiation';
UPDATE public.questions SET leader_weight = 0.0364, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Trustworthiness';
UPDATE public.questions SET leader_weight = 0.0182, manager_weight = 0.0227, ic_weight = 0.2083 WHERE question_text = 'Logic';
UPDATE public.questions SET leader_weight = 0.0182, manager_weight = 0.0227, ic_weight = 0.2083 WHERE question_text = 'Critical Thinking';
UPDATE public.questions SET leader_weight = 0.0182, manager_weight = 0.0341, ic_weight = 0.0000 WHERE question_text = 'Discipline';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0000, ic_weight = 0.0000 WHERE question_text = 'Story Telling';
UPDATE public.questions SET leader_weight = 0.0182, manager_weight = 0.0000, ic_weight = 0.0417 WHERE question_text = 'Curiosity';
UPDATE public.questions SET leader_weight = 0.0273, manager_weight = 0.0455, ic_weight = 0.2083 WHERE question_text = 'Problem Solving';
UPDATE public.questions SET leader_weight = 0.0364, manager_weight = 0.0000, ic_weight = 0.1667 WHERE question_text = 'Innovation';

INSERT INTO public.questions (question_text, leader_weight, manager_weight, ic_weight) VALUES
  ('Planning',           0.0091, 0.0568, 0.0000),
  ('Consistency',        0.0091, 0.0341, 0.0000),
  ('Diligence',          0.0091, 0.0227, 0.0000),
  ('Time Management',    0.0364, 0.0455, 0.0000),
  ('Coordination',       0.0182, 0.0568, 0.0000),
  ('Strategic Thinking', 0.0455, 0.0227, 0.0000),
  ('Decision Making',    0.0182, 0.0568, 0.0000),
  ('Influence',          0.0455, 0.0114, 0.0000),
  ('Inspiration',        0.0455, 0.0000, 0.0000),
  ('Coaching',           0.0364, 0.0341, 0.0000),
  ('Accountability',     0.0091, 0.0568, 0.0000);

SELECT
  ROUND(SUM(leader_weight)::numeric,  4) AS total_leader,
  ROUND(SUM(manager_weight)::numeric, 4) AS total_manager,
  ROUND(SUM(ic_weight)::numeric,      4) AS total_ic,
  COUNT(*) AS total_questions
FROM public.questions;

COMMIT;
