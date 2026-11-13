-- =====================================================================
--  Citadel Job Req Reporting — Split Hiring Need into Immediate & Planned
--  Project: xcxycbbfsanmnjiwgrfl        Applied: 2026-11-13
-- ---------------------------------------------------------------------
--  Client split the single "Hiring Needs" into two GHL fields:
--    Immediate Vacancy            (fieldKey hiring_need, webhook key "Hiring Needs")
--    Planned Replacement Hiring Need (webhook key "Planned Replacement Hiring Need")
--  Immediate IS the old hiring_need field, so immediate_openings is backfilled
--  from hiring_needs. planned_openings stays NULL until records are re-saved in
--  GHL with a planned value.
--  Safe, additive, idempotent.
-- =====================================================================

BEGIN;

ALTER TABLE job_requisitions
  ADD COLUMN IF NOT EXISTS immediate_openings integer,
  ADD COLUMN IF NOT EXISTS planned_openings   integer;

UPDATE job_requisitions
SET immediate_openings = hiring_needs
WHERE immediate_openings IS NULL;

COMMIT;
