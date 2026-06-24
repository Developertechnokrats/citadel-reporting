-- ============================================================
-- MIGRATION 002: Add source column to job_cycles
-- Run in Supabase SQL Editor
-- ============================================================

-- Step 1: Add the column
ALTER TABLE job_cycles
  ADD COLUMN IF NOT EXISTS source VARCHAR(10) DEFAULT 'ghl';

-- Step 2: Mark existing CSV-sourced cycles
-- (uses a subquery instead of JOIN syntax which Supabase doesn't support in UPDATE)
UPDATE job_cycles
SET source = 'csv'
WHERE id IN (
  SELECT DISTINCT c.id
  FROM job_cycles c
  WHERE EXISTS (
    SELECT 1
    FROM job_status_history h
    WHERE h.tracktik_post_id = c.tracktik_post_id
      AND h.cycle_number     = c.cycle_number
      AND h.raw_payload::text LIKE '%csv_import%'
  )
);

-- Step 3: Verify
SELECT source, COUNT(*) AS count
FROM job_cycles
GROUP BY source
ORDER BY source;
