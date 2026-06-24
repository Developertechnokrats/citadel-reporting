-- ============================================================
-- CLEANUP 001: Remove all data before Apr 01, 2026
-- Run in Supabase SQL Editor AFTER migration_001
-- ============================================================
-- SAFE TO RUN: uses transactions, shows preview counts first
-- ============================================================

BEGIN;

-- ── Preview what will be deleted BEFORE committing ───────────

-- Cycles before Apr 1
SELECT 
  'job_cycles to delete' AS what,
  COUNT(*) AS count
FROM job_cycles
WHERE opened_at < '2026-04-01 00:00:00+00';

-- Jobs that will have ZERO cycles remaining after cleanup
SELECT 
  'job_requisitions with all cycles pre-Apr1 (will be deleted)' AS what,
  COUNT(*) AS count
FROM job_requisitions j
WHERE NOT EXISTS (
  SELECT 1 FROM job_cycles c
  WHERE c.tracktik_post_id = j.tracktik_post_id
    AND c.opened_at >= '2026-04-01 00:00:00+00'
)
AND NOT EXISTS (
  SELECT 1 FROM job_cycles c2
  WHERE c2.tracktik_post_id = j.tracktik_post_id
    AND c2.is_open = TRUE
);

-- ── Step 1: Delete history records for pre-Apr1 cycles ───────
DELETE FROM job_status_history
WHERE tracktik_post_id IN (
  SELECT DISTINCT tracktik_post_id
  FROM job_cycles
  WHERE opened_at < '2026-04-01 00:00:00+00'
)
AND recorded_at < '2026-04-01 00:00:00+00';

-- ── Step 2: Delete pre-Apr1 cycles ───────────────────────────
DELETE FROM job_cycles
WHERE opened_at < '2026-04-01 00:00:00+00';

-- ── Step 3: Renumber remaining cycles per job ─────────────────
-- Reset cycle_number to be sequential (1,2,3...) after deletion
UPDATE job_cycles c
SET cycle_number = sub.new_cycle_number
FROM (
  SELECT 
    id,
    tracktik_post_id,
    ROW_NUMBER() OVER (
      PARTITION BY tracktik_post_id 
      ORDER BY opened_at ASC
    ) AS new_cycle_number
  FROM job_cycles
) sub
WHERE c.id = sub.id
  AND c.cycle_number != sub.new_cycle_number;

-- ── Step 4: Update total_cycles count on each job ─────────────
UPDATE job_requisitions j
SET total_cycles = (
  SELECT COUNT(*) 
  FROM job_cycles c 
  WHERE c.tracktik_post_id = j.tracktik_post_id
);

-- ── Step 5: Delete jobs with zero remaining cycles ─────────────
-- (these are jobs that existed entirely before Apr 1)
DELETE FROM job_requisitions
WHERE total_cycles = 0
  AND (first_seen_at IS NULL OR first_seen_at < '2026-04-01 00:00:00+00');

-- ── Step 6: Recalculate pct_time_to_hire per job ──────────────
-- After removing cycles, percentages need recalculating
UPDATE job_cycles c
SET pct_time_to_hire = sub.new_pct
FROM (
  SELECT 
    c2.id,
    c2.tracktik_post_id,
    c2.days_to_hire,
    CASE 
      WHEN SUM(c2.days_to_hire) OVER (PARTITION BY c2.tracktik_post_id) > 0
      THEN ROUND(
        (c2.days_to_hire / SUM(c2.days_to_hire) OVER (PARTITION BY c2.tracktik_post_id)) * 100,
        2
      )
      ELSE NULL
    END AS new_pct
  FROM job_cycles c2
  WHERE c2.days_to_hire IS NOT NULL
) sub
WHERE c.id = sub.id
  AND c.days_to_hire IS NOT NULL;

-- ── Final count check ─────────────────────────────────────────
SELECT 'After cleanup:' AS status;
SELECT 'job_requisitions' AS tbl, COUNT(*) FROM job_requisitions
UNION ALL SELECT 'job_cycles', COUNT(*) FROM job_cycles
UNION ALL SELECT 'job_status_history', COUNT(*) FROM job_status_history;

-- ── If you're happy with the numbers above, run: COMMIT;
-- ── If something looks wrong, run: ROLLBACK;
-- COMMIT;
-- ROLLBACK;
