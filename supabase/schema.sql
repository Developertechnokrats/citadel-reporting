-- ============================================================
-- JOB REQUISITION DASHBOARD - SUPABASE SCHEMA
-- Run this entire file in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- TABLE 1: job_requisitions
-- Master record per TrackTik Post ID
-- ============================================================
CREATE TABLE IF NOT EXISTS job_requisitions (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tracktik_post_id            TEXT UNIQUE NOT NULL,
  ghl_id                      TEXT,

  -- Job details
  advertised_pay_rate         TEXT,
  applicant_radius            TEXT,
  applicant_stack_status      TEXT,
  city_of_site_location       TEXT,
  disqualifying_questions     TEXT,
  employment_status           TEXT,
  hiring_manager              TEXT,
  hr_approval_status          TEXT,
  in_person_interview_address TEXT,
  industry                    TEXT,
  interview_calendar          TEXT,
  interview_type              TEXT,
  job_duties                  TEXT,
  officer_type                TEXT,
  other_preferences           TEXT,
  position_specific_requirements TEXT,
  position_start_date         TEXT,
  position_status             TEXT,
  preferred_screening_questions TEXT,
  region                      TEXT,
  schedule                    TEXT,
  serviceable_zip_code        TEXT,
  site_name_position_shift    TEXT,
  state_of_site_location      TEXT,
  tier1_zip_codes             TEXT,
  tier2_zip_codes             TEXT,
  tier3_zip_codes             TEXT,
  tracktik_site_id            TEXT,
  zip_code_of_site            TEXT,

  -- Status tracking
  current_status              TEXT DEFAULT 'created',  -- created | open | closed
  total_cycles                INT DEFAULT 0,

  -- Timestamps
  first_seen_at               TIMESTAMPTZ DEFAULT NOW(),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- TABLE 2: job_status_history
-- Every webhook event stored forever
-- ============================================================
CREATE TABLE IF NOT EXISTS job_status_history (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tracktik_post_id  TEXT NOT NULL REFERENCES job_requisitions(tracktik_post_id) ON DELETE CASCADE,
  status            TEXT NOT NULL,           -- created | open | closed
  cycle_number      INT,                     -- which cycle this event belongs to
  recorded_at       TIMESTAMPTZ DEFAULT NOW(),
  raw_payload       JSONB                    -- full JSON from GHL
);

-- ============================================================
-- TABLE 3: job_cycles
-- One row per open→close pair
-- ============================================================
CREATE TABLE IF NOT EXISTS job_cycles (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tracktik_post_id  TEXT NOT NULL REFERENCES job_requisitions(tracktik_post_id) ON DELETE CASCADE,
  cycle_number      INT NOT NULL,
  opened_at         TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  days_to_hire      NUMERIC(10, 2),          -- closed_at - opened_at in days
  pct_time_to_hire  NUMERIC(10, 2),          -- this cycle / total days * 100
  is_open           BOOLEAN DEFAULT TRUE,    -- true if not yet closed
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(tracktik_post_id, cycle_number)
);

-- ============================================================
-- INDEXES for fast dashboard filtering
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_job_req_tracktik    ON job_requisitions(tracktik_post_id);
CREATE INDEX IF NOT EXISTS idx_job_req_status      ON job_requisitions(current_status);
CREATE INDEX IF NOT EXISTS idx_job_req_region      ON job_requisitions(region);
CREATE INDEX IF NOT EXISTS idx_job_req_city        ON job_requisitions(city_of_site_location);
CREATE INDEX IF NOT EXISTS idx_job_req_manager     ON job_requisitions(hiring_manager);
CREATE INDEX IF NOT EXISTS idx_job_req_updated     ON job_requisitions(updated_at);

CREATE INDEX IF NOT EXISTS idx_history_tracktik    ON job_status_history(tracktik_post_id);
CREATE INDEX IF NOT EXISTS idx_history_status      ON job_status_history(status);
CREATE INDEX IF NOT EXISTS idx_history_recorded    ON job_status_history(recorded_at);
CREATE INDEX IF NOT EXISTS idx_history_cycle       ON job_status_history(cycle_number);

CREATE INDEX IF NOT EXISTS idx_cycles_tracktik     ON job_cycles(tracktik_post_id);
CREATE INDEX IF NOT EXISTS idx_cycles_opened       ON job_cycles(opened_at);
CREATE INDEX IF NOT EXISTS idx_cycles_closed       ON job_cycles(closed_at);
CREATE INDEX IF NOT EXISTS idx_cycles_is_open      ON job_cycles(is_open);

-- ============================================================
-- FUNCTION: Recalculate pct_time_to_hire for all cycles of a job
-- Called after every close event
-- ============================================================
CREATE OR REPLACE FUNCTION recalculate_pct_time_to_hire(p_tracktik_post_id TEXT)
RETURNS VOID AS $$
DECLARE
  total_days NUMERIC;
BEGIN
  -- Sum all closed cycles' days_to_hire
  SELECT COALESCE(SUM(days_to_hire), 0)
  INTO total_days
  FROM job_cycles
  WHERE tracktik_post_id = p_tracktik_post_id
    AND days_to_hire IS NOT NULL;

  -- Update pct for each cycle
  IF total_days > 0 THEN
    UPDATE job_cycles
    SET pct_time_to_hire = ROUND((days_to_hire / total_days) * 100, 2),
        updated_at = NOW()
    WHERE tracktik_post_id = p_tracktik_post_id
      AND days_to_hire IS NOT NULL;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- ROW LEVEL SECURITY (optional but recommended)
-- ============================================================
ALTER TABLE job_requisitions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_cycles         ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access (used by your webhook)
CREATE POLICY "service_role_all_job_requisitions"
  ON job_requisitions FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_job_status_history"
  ON job_status_history FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "service_role_all_job_cycles"
  ON job_cycles FOR ALL
  TO service_role USING (true) WITH CHECK (true);

-- Allow anon read (for dashboard - tighten this with auth if needed)
CREATE POLICY "anon_read_job_requisitions"
  ON job_requisitions FOR SELECT
  TO anon USING (true);

CREATE POLICY "anon_read_job_status_history"
  ON job_status_history FOR SELECT
  TO anon USING (true);

CREATE POLICY "anon_read_job_cycles"
  ON job_cycles FOR SELECT
  TO anon USING (true);

-- ============================================================
-- TABLE 4: import_batches
-- Tracks every CSV import for audit + undo capability
-- ============================================================
CREATE TABLE IF NOT EXISTS import_batches (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  filename      TEXT,
  imported_at   TIMESTAMPTZ DEFAULT NOW(),
  total_jobs    INT,
  total_cycles  INT,
  status        TEXT DEFAULT 'completed',  -- completed | reverted
  snapshot      JSONB                      -- pre-import state, for undo
);

CREATE INDEX IF NOT EXISTS idx_import_batches_status ON import_batches(status);
CREATE INDEX IF NOT EXISTS idx_import_batches_date   ON import_batches(imported_at);

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_import_batches"
  ON import_batches FOR ALL
  TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "anon_read_import_batches"
  ON import_batches FOR SELECT
  TO anon USING (true);

-- ============================================================
-- Done! Verify with:
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';
-- ============================================================
