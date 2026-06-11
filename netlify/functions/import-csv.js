// netlify/functions/import-csv.js
//
// Receives a CSV file (as plain text in the POST body) exported from
// ApplicantStack, applies the cycle-detection algorithm, and bulk-loads
// the results into Supabase. Records a snapshot of everything that
// existed BEFORE the import so it can be fully undone via /undo-import.
//
// ── ALGORITHM ────────────────────────────────────────────────
// Each row's "Job ID" looks like "00085-UAFTMP01" — the trailing 2 digits
// are an ApplicantStack repost counter and get stripped to produce the
// real TrackTik Post ID: "00085-UAFTMP".
//
// All rows sharing the same base TrackTik Post ID are sorted by
// "Job Date Created" and walked chronologically:
//
//   - "Indeed Refresh" / "Posted"  -> ignored (just repost noise)
//   - "Position Filled"            -> CLOSES the current cycle
//                                      (counted in Days-to-Hire averages)
//   - "Withdrawn", more rows follow -> ignored (just repost noise)
//   - "Withdrawn", LAST row overall -> CLOSES the cycle as "withdrawn"
//                                      (excluded from Days-to-Hire averages)
//   - nothing closes the chain      -> cycle is still OPEN today
// ───────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { parse } = require("csv-parse/sync");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ───────────────────────────────────────────────────
function baseId(jobId) {
  const m = jobId.match(/^(.*?)(\d{2})$/);
  return m ? m[1] : jobId;
}

function parseDate(str) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let [, mm, dd, yy, hh, min, ampm] = m;
  mm = parseInt(mm, 10); dd = parseInt(dd, 10); yy = 2000 + parseInt(yy, 10);
  hh = parseInt(hh, 10); min = parseInt(min, 10);
  if (ampm.toUpperCase() === "PM" && hh !== 12) hh += 12;
  if (ampm.toUpperCase() === "AM" && hh === 12) hh = 0;
  return new Date(yy, mm - 1, dd, hh, min);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function normalizeRegion(region) {
  if (!region) return null;
  const map = {
    "Western Slopes Region": "western_slopes_region",
    "Front Range Region":    "front_range_region",
    "Missouri Region":       "missouri_region",
    "Iowa Region":           "iowa_region",
    "Kentucky Region":       "kentucky_region",
    "Special Events":        "special_events",
    "Admin":                 "admin",
  };
  return map[region.trim()] || region.trim().toLowerCase().replace(/\s+/g, "_");
}

function normalizeOfficerType(val) {
  if (!val) return null;
  const map = {
    "Armed Officer":   "armed",
    "Unarmed Officer": "unarmed",
  };
  return map[val.trim()] || val.trim().toLowerCase().replace(/\s+/g, "_");
}

// ── Cycle detection ───────────────────────────────────────────
function computeCycles(rowsForId) {
  const sorted = [...rowsForId].sort(
    (a, b) => parseDate(a["Job Date Created"]) - parseDate(b["Job Date Created"])
  );

  const cycles = [];
  let cycleOpen = null;
  const n = sorted.length;

  sorted.forEach((r, i) => {
    if (cycleOpen === null) {
      cycleOpen = parseDate(r["Job Date Created"]);
    }
    const stage = r["Job Stage Name"];
    const isLast = i === n - 1;

    if (stage === "Position Filled") {
      const close = parseDate(r["Job Last Modified"]);
      const days = (close - cycleOpen) / (1000 * 60 * 60 * 24);
      cycles.push({ opened_at: cycleOpen, closed_at: close, days_to_hire: round2(days), reason: "filled" });
      cycleOpen = null;
    } else if (stage === "Withdrawn" && isLast) {
      const close = parseDate(r["Job Last Modified"]);
      cycles.push({ opened_at: cycleOpen, closed_at: close, days_to_hire: null, reason: "withdrawn" });
      cycleOpen = null;
    }
  });

  if (cycleOpen !== null) {
    cycles.push({ opened_at: cycleOpen, closed_at: null, days_to_hire: null, reason: "still_open" });
  }

  return cycles;
}

// ── Main handler ────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { filename, csv } = body;
  if (!csv || typeof csv !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'csv' text content" }) };
  }

  try {
    // ── Parse CSV ─────────────────────────────────────────────
    const rows = parse(csv, { columns: true, skip_empty_lines: true });
    if (!rows.length) {
      return { statusCode: 400, body: JSON.stringify({ error: "CSV file is empty" }) };
    }

    const requiredCols = ["Job ID", "Job Date Created", "Job Last Modified", "Job Stage Name"];
    const missingCols = requiredCols.filter(c => !(c in rows[0]));
    if (missingCols.length) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `CSV is missing required columns: ${missingCols.join(", ")}` }),
      };
    }

    // ── Group by base TrackTik Post ID ─────────────────────────
    const groups = new Map();
    for (const r of rows) {
      if (!r["Job ID"] || !r["Job ID"].trim()) continue;
      const id = baseId(r["Job ID"].trim());
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(r);
    }

    const postIds = [...groups.keys()];

    // ── STEP 1: Snapshot existing state for these post IDs (for undo) ─
    const { data: existingJobs, error: existErr } = await supabase
      .from("job_requisitions")
      .select("*")
      .in("tracktik_post_id", postIds);
    if (existErr) throw new Error(`Snapshot jobs: ${existErr.message}`);

    const { data: existingCycles, error: existCycErr } = await supabase
      .from("job_cycles")
      .select("*")
      .in("tracktik_post_id", postIds);
    if (existCycErr) throw new Error(`Snapshot cycles: ${existCycErr.message}`);

    const { data: existingHistory, error: existHistErr } = await supabase
      .from("job_status_history")
      .select("*")
      .in("tracktik_post_id", postIds);
    if (existHistErr) throw new Error(`Snapshot history: ${existHistErr.message}`);

    const existingPostIdSet = new Set((existingJobs || []).map(j => j.tracktik_post_id));
    const newPostIds = postIds.filter(id => !existingPostIdSet.has(id));

    const snapshot = {
      post_ids:        postIds,
      new_post_ids:    newPostIds,
      jobs:            existingJobs || [],
      cycles:          existingCycles || [],
      history:         existingHistory || [],
    };

    // ── STEP 2: Build new records from CSV ─────────────────────
    const jobRecords = [];
    const cycleRecords = [];
    const historyRecords = [];

    for (const [trackTikPostId, groupRows] of groups.entries()) {
      const sortedByDate = [...groupRows].sort(
        (a, b) => parseDate(a["Job Date Created"]) - parseDate(b["Job Date Created"])
      );
      const latest = sortedByDate[sortedByDate.length - 1];
      const earliest = sortedByDate[0];

      const cycles = computeCycles(groupRows);
      const lastCycle = cycles[cycles.length - 1];
      const currentStatus = lastCycle && lastCycle.reason === "still_open" ? "open" : "closed";

      jobRecords.push({
        tracktik_post_id:         trackTikPostId,
        tracktik_site_id:         latest["TrackTik Site ID"] || null,
        site_name_position_shift: latest["Site Name - Position Type - Shift"] || null,
        region:                   normalizeRegion(latest["Region"]),
        hiring_manager:           latest["Hiring Manager"] || null,
        officer_type:             normalizeOfficerType(latest["Officer Type"]),
        position_start_date:      latest["Position Start Date"] || null,
        advertised_pay_rate:      latest["Salary Range"] || null,
        current_status:           currentStatus,
        total_cycles:             cycles.length,
        first_seen_at:            parseDate(earliest["Job Date Created"]).toISOString(),
        created_at:               parseDate(earliest["Job Date Created"]).toISOString(),
        updated_at:               new Date().toISOString(),
      });

      const totalFilledDays = cycles
        .filter(c => c.reason === "filled")
        .reduce((sum, c) => sum + c.days_to_hire, 0);

      cycles.forEach((c, i) => {
        const cycleNumber = i + 1;
        let pct = null;
        if (c.reason === "filled" && totalFilledDays > 0) {
          pct = round2((c.days_to_hire / totalFilledDays) * 100);
        }

        cycleRecords.push({
          tracktik_post_id: trackTikPostId,
          cycle_number:     cycleNumber,
          opened_at:        c.opened_at.toISOString(),
          closed_at:        c.closed_at ? c.closed_at.toISOString() : null,
          days_to_hire:     c.days_to_hire,
          pct_time_to_hire: pct,
          is_open:          c.closed_at === null,
        });

        historyRecords.push({
          tracktik_post_id: trackTikPostId,
          status:           "open",
          cycle_number:     cycleNumber,
          recorded_at:      c.opened_at.toISOString(),
          raw_payload:      { source: "csv_import", filename, reason: "cycle_open" },
        });

        if (c.closed_at) {
          historyRecords.push({
            tracktik_post_id: trackTikPostId,
            status:           "closed",
            cycle_number:     cycleNumber,
            recorded_at:      c.closed_at.toISOString(),
            raw_payload:      { source: "csv_import", filename, reason: c.reason },
          });
        }
      });
    }

    // ── STEP 3: Apply changes (bulk operations) ─────────────────
    // Delete old cycles/history for these post IDs, then bulk insert new ones
    const { error: delCycErr } = await supabase
      .from("job_cycles")
      .delete()
      .in("tracktik_post_id", postIds);
    if (delCycErr) throw new Error(`Delete cycles: ${delCycErr.message}`);

    const { error: delHistErr } = await supabase
      .from("job_status_history")
      .delete()
      .in("tracktik_post_id", postIds);
    if (delHistErr) throw new Error(`Delete history: ${delHistErr.message}`);

    // Upsert job_requisitions (bulk)
    const { error: upsertErr } = await supabase
      .from("job_requisitions")
      .upsert(jobRecords, { onConflict: "tracktik_post_id" });
    if (upsertErr) throw new Error(`Upsert jobs: ${upsertErr.message}`);

    // Bulk insert cycles (chunk to avoid payload limits)
    for (let i = 0; i < cycleRecords.length; i += 500) {
      const chunk = cycleRecords.slice(i, i + 500);
      const { error } = await supabase.from("job_cycles").insert(chunk);
      if (error) throw new Error(`Insert cycles: ${error.message}`);
    }

    // Bulk insert history (chunk to avoid payload limits)
    for (let i = 0; i < historyRecords.length; i += 500) {
      const chunk = historyRecords.slice(i, i + 500);
      const { error } = await supabase.from("job_status_history").insert(chunk);
      if (error) throw new Error(`Insert history: ${error.message}`);
    }

    // ── STEP 4: Record this batch for undo ──────────────────────
    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        filename:     filename || "upload.csv",
        total_jobs:   jobRecords.length,
        total_cycles: cycleRecords.length,
        status:       "completed",
        snapshot,
      })
      .select()
      .single();
    if (batchErr) throw new Error(`Record batch: ${batchErr.message}`);

    // ── STEP 5: Summary stats ────────────────────────────────────
    const filled = cycleRecords.filter(c => c.days_to_hire !== null && c.is_open === false && c.pct_time_to_hire !== null).length;
    const withdrawn = cycleRecords.filter(c => !c.is_open && c.days_to_hire === null).length;
    const stillOpen = cycleRecords.filter(c => c.is_open).length;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        batch_id: batch.id,
        csv_rows: rows.length,
        jobs_processed: jobRecords.length,
        new_jobs: newPostIds.length,
        updated_jobs: jobRecords.length - newPostIds.length,
        total_cycles: cycleRecords.length,
        filled_cycles: filled,
        withdrawn_cycles: withdrawn,
        still_open_cycles: stillOpen,
      }),
    };

  } catch (err) {
    console.error(`[Import Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
