-- ============================================================
-- MIGRATION: Add import_batches table (CSV upload feature)
-- Run this in Supabase SQL Editor if you already deployed the
-- original schema.sql — this only ADDS a new table, nothing
-- existing is changed or deleted.
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

-- Verify:
-- SELECT * FROM import_batches;
