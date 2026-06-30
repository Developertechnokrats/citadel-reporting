-- ============================================================
-- CORRECTION: Fix opened_at for jobs where the original GHL
-- webhook failed (likely during the Jun 21-23 Supabase pause)
-- and only a later retry/duplicate succeeded.
--
-- Source of truth: GHL audit log (Job_req_20th_June_to_26th_June.xlsx)
-- ============================================================

BEGIN;

-- Preview current vs correct values before applying
SELECT
  tracktik_post_id,
  cycle_number,
  opened_at AS current_opened_at,
  CASE tracktik_post_id
    WHEN 'P01204-UAPT'   THEN '2026-06-22T19:49:08.029Z'::timestamptz
    WHEN 'P01204-UAPTD'  THEN '2026-06-26T20:18:47.650Z'::timestamptz
    WHEN 'P01204-UAPTE'  THEN '2026-06-26T20:24:08.875Z'::timestamptz
    WHEN 'P01272-UAPTSE' THEN '2026-06-26T20:32:13.092Z'::timestamptz
  END AS correct_opened_at
FROM job_cycles
WHERE tracktik_post_id IN ('P01204-UAPT', 'P01204-UAPTD', 'P01204-UAPTE', 'P01272-UAPTSE')
  AND is_open = true;

-- Apply corrections
UPDATE job_cycles
SET opened_at = '2026-06-22T19:49:08.029Z'::timestamptz
WHERE tracktik_post_id = 'P01204-UAPT' AND is_open = true;

UPDATE job_cycles
SET opened_at = '2026-06-26T20:18:47.650Z'::timestamptz
WHERE tracktik_post_id = 'P01204-UAPTD' AND is_open = true;

UPDATE job_cycles
SET opened_at = '2026-06-26T20:24:08.875Z'::timestamptz
WHERE tracktik_post_id = 'P01204-UAPTE' AND is_open = true;

UPDATE job_cycles
SET opened_at = '2026-06-26T20:32:13.092Z'::timestamptz
WHERE tracktik_post_id = 'P01272-UAPTSE' AND is_open = true;

-- Also correct first_seen_at on job_requisitions to match
UPDATE job_requisitions SET first_seen_at = '2026-06-22T19:49:08.029Z'::timestamptz
WHERE tracktik_post_id = 'P01204-UAPT';
UPDATE job_requisitions SET first_seen_at = '2026-06-26T20:18:47.650Z'::timestamptz
WHERE tracktik_post_id = 'P01204-UAPTD';
UPDATE job_requisitions SET first_seen_at = '2026-06-26T20:24:08.875Z'::timestamptz
WHERE tracktik_post_id = 'P01204-UAPTE';
UPDATE job_requisitions SET first_seen_at = '2026-06-26T20:32:13.092Z'::timestamptz
WHERE tracktik_post_id = 'P01272-UAPTSE';

-- Verify
SELECT tracktik_post_id, cycle_number, opened_at, is_open
FROM job_cycles
WHERE tracktik_post_id IN ('P01204-UAPT', 'P01204-UAPTD', 'P01204-UAPTE', 'P01272-UAPTSE')
ORDER BY tracktik_post_id;

-- If correct, run: COMMIT;
-- If something looks wrong, run: ROLLBACK;
