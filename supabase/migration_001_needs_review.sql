-- ============================================================
-- MIGRATION 001: Add needs_review fields to job_requisitions
-- Run in Supabase SQL Editor FIRST before any other steps
-- ============================================================

ALTER TABLE job_requisitions
  ADD COLUMN IF NOT EXISTS needs_review   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_notes   TEXT    DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_job_req_needs_review ON job_requisitions(needs_review);

SELECT 'Migration 001 complete — needs_review columns added' AS message;
