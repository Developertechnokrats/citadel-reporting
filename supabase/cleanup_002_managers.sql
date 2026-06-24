-- ============================================================
-- CLEANUP 002: Fix duplicate hiring manager names
-- Run in Supabase SQL Editor AFTER cleanup_001
-- ============================================================
-- Fixes case/typo variants, keeps the most-used spelling
-- ============================================================

BEGIN;

-- Preview before making changes
SELECT 
  hiring_manager,
  COUNT(*) AS job_count
FROM job_requisitions
WHERE hiring_manager IN (
  'Brandon SOll', 'Brandon Soll',
  'Heather jordan', 'Heather Jordan',
  'Spencer Lane, Heather Jordan',
  'Kaitlyn Antolic', 'Kaithlyn Antolic'
)
GROUP BY hiring_manager
ORDER BY hiring_manager;

-- ── Fix 1: Brandon SOll → Brandon Soll ──────────────────────
UPDATE job_requisitions
SET hiring_manager = 'Brandon Soll'
WHERE hiring_manager = 'Brandon SOll';

-- ── Fix 2: Heather jordan → Heather Jordan ──────────────────
UPDATE job_requisitions
SET hiring_manager = 'Heather Jordan'
WHERE hiring_manager = 'Heather jordan';

-- ── Fix 3: Kaitlyn Antolic spelling variants ─────────────────
-- Check both spellings and keep the most common
UPDATE job_requisitions
SET hiring_manager = 'Kaitlyn Antolic'
WHERE hiring_manager IN ('Kaithlyn Antolic', 'Kaithlyn Antolic');

-- ── Verify: no more duplicates ────────────────────────────────
SELECT 
  LOWER(TRIM(hiring_manager)) AS normalized,
  ARRAY_AGG(DISTINCT hiring_manager) AS variants,
  COUNT(*) AS total_jobs
FROM job_requisitions
WHERE hiring_manager IS NOT NULL
GROUP BY LOWER(TRIM(hiring_manager))
HAVING COUNT(DISTINCT hiring_manager) > 1;

-- If no rows returned above = all clean ✅

COMMIT;

SELECT 'Manager deduplication complete' AS message;
