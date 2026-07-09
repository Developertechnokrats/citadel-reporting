-- ============================================================
-- MIGRATION 003: manual_corrections table
-- Stores every admin edit to job_cycles for full audit trail.
-- This table is NEVER queried by the main dashboard — admin only.
-- ============================================================

CREATE TABLE IF NOT EXISTS manual_corrections (
  id                  UUID          DEFAULT gen_random_uuid() PRIMARY KEY,
  tracktik_post_id    VARCHAR(100)  NOT NULL,
  correction_type     VARCHAR(50)   NOT NULL, -- 'cycle_edit' | 'cycle_add' | 'cycle_delete' | 'bulk_import'
  cycle_number        INT           NULL,
  before_state        JSONB         NULL,     -- snapshot of cycle BEFORE change
  after_state         JSONB         NULL,     -- snapshot of cycle AFTER change
  note                TEXT          NULL,     -- admin's reason / comment
  corrected_by        VARCHAR(100)  DEFAULT 'admin',
  created_at          TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corrections_post_id ON manual_corrections(tracktik_post_id);
CREATE INDEX IF NOT EXISTS idx_corrections_created  ON manual_corrections(created_at DESC);

SELECT 'Migration 003 complete — manual_corrections table created' AS message;
