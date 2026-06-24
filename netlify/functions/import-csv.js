// netlify/functions/import-csv.js
// ─────────────────────────────────────────────────────────────
// IMPORT STRATEGY:
//   For each TrackTik Post ID in the CSV:
//   1. Delete all existing CSV-sourced cycles (source = 'csv')
//   2. Keep all GHL-sourced cycles (source = 'ghl') untouched
//   3. Insert fresh cycles from CSV
//   4. If job doesn't exist → insert it
//   5. If job exists → don't overwrite field values (GHL wins)
// ─────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");
const { parse }        = require("csv-parse/sync");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── Helpers ───────────────────────────────────────────────────
function parseDate(str) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let [, mm, dd, yy, hh, min, ampm] = m;
  mm=parseInt(mm,10); dd=parseInt(dd,10); yy=2000+parseInt(yy,10);
  hh=parseInt(hh,10); min=parseInt(min,10);
  if (ampm.toUpperCase()==="PM" && hh!==12) hh+=12;
  if (ampm.toUpperCase()==="AM" && hh===12) hh=0;
  return new Date(Date.UTC(yy, mm-1, dd, hh, min));
}

function parseTimeToFill(str) {
  if (!str || !str.trim()) return null;
  const m = str.trim().match(/^(\d+\.?\d*)\s*Day/i);
  return m ? parseFloat(m[1]) : null;
}

function round2(n) { return Math.round(n*100)/100; }

function normalizeRegion(r) {
  if (!r) return null;
  const map = {
    "Western Slopes Region": "western_slopes_region",
    "Front Range Region":    "front_range_region",
    "Missouri Region":       "missouri_region",
    "Iowa Region":           "iowa_region",
    "Kentucky Region":       "kentucky_region",
    "Special Events":        "special_events",
    "Admin":                 "admin",
  };
  return map[r.trim()] || r.trim().toLowerCase().replace(/\s+/g,"_");
}

function normalizeOfficerType(v) {
  if (!v) return null;
  const map = { "Armed Officer":"armed","Unarmed Officer":"unarmed" };
  return map[v.trim()] || v.trim().toLowerCase().replace(/\s+/g,"_");
}

function normalizeManager(name) {
  if (!name) return null;
  const fixes = {
    "brandon soll":                  "Brandon Soll",
    "heather jordan":                "Heather Jordan",
    "kaithlyn antolic":              "Kaitlyn Antolic",
    "spencer lane, heather jordan":  "Spencer Lane",
  };
  return fixes[name.trim().toLowerCase()] || name.trim();
}

// ── Cycle detection ───────────────────────────────────────────
function computeCycles(rowsForId) {
  const sorted = [...rowsForId].sort(
    (a,b) => parseDate(a["Job Date Created"]) - parseDate(b["Job Date Created"])
  );
  const cycles = [];
  let cycleOpen = null;
  let lastRepost = null;
  const n = sorted.length;

  sorted.forEach((r, i) => {
    if (cycleOpen === null) cycleOpen = parseDate(r["Job Date Created"]);
    lastRepost = parseDate(r["Job Date Created"]);
    const stage  = r["Job Stage Name"];
    const isLast = i === n - 1;

    if (stage === "Position Filled") {
      const close = parseDate(r["Job Last Modified"]);
      let days = parseTimeToFill(r["Time to Fill"]);
      if (days === null && lastRepost && close)
        days = round2((close - lastRepost) / (1000*60*60*24));
      cycles.push({ opened_at: cycleOpen, closed_at: close, days_to_hire: days, reason: "filled" });
      cycleOpen = null; lastRepost = null;
    } else if (stage === "Withdrawn" && isLast) {
      cycles.push({ opened_at: cycleOpen, closed_at: parseDate(r["Job Last Modified"]), days_to_hire: null, reason: "withdrawn" });
      cycleOpen = null;
    }
    // Indeed Refresh / Posted → ignored
  });

  if (cycleOpen !== null)
    cycles.push({ opened_at: cycleOpen, closed_at: null, days_to_hire: null, reason: "still_open" });

  return cycles;
}

// ── Main handler ──────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode:405, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"Method not allowed" }) };

  // ── Read CSV from plain text body ─────────────────────────
  let filename = event.headers["x-filename"] || event.headers["X-Filename"] || "upload.csv";
  let csvText  = "";

  try {
    const contentType = (event.headers["content-type"] || event.headers["Content-Type"] || "").toLowerCase();
    if (contentType.includes("text/csv") || contentType.includes("text/plain")) {
      csvText = event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString("utf8")
        : event.body || "";
    } else {
      const body = JSON.parse(event.body || "{}");
      filename   = body.filename || filename;
      csvText    = body.csv || "";
    }
  } catch(e) {
    return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"Parse error: "+e.message }) };
  }

  if (!csvText || !csvText.trim())
    return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"No CSV content received" }) };

  // ── Parse CSV ─────────────────────────────────────────────
  let rows;
  try { rows = parse(csvText, { columns:true, skip_empty_lines:true }); }
  catch(e) { return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"Cannot parse CSV: "+e.message }) }; }

  if (!rows.length)
    return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"CSV is empty" }) };

  const required = ["TrackTik Post ID","Job Date Created","Job Last Modified","Job Stage Name"];
  const missing  = required.filter(c => !(c in rows[0]));
  if (missing.length)
    return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"Missing columns: "+missing.join(", ") }) };

  // ── Group by TrackTik Post ID ─────────────────────────────
  const groups = new Map();
  for (const r of rows) {
    const tid = (r["TrackTik Post ID"] || "").trim();
    if (!tid) continue;
    if (!groups.has(tid)) groups.set(tid, []);
    groups.get(tid).push(r);
  }

  const postIds = [...groups.keys()];
  if (!postIds.length)
    return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"No valid TrackTik Post IDs found" }) };

  try {
    // ── Snapshot for undo ─────────────────────────────────
    const [{ data: existingJobs }, { data: existingCycles }, { data: existingHistory }] = await Promise.all([
      supabase.from("job_requisitions").select("*").in("tracktik_post_id", postIds),
      supabase.from("job_cycles").select("*").in("tracktik_post_id", postIds),
      supabase.from("job_status_history").select("*").in("tracktik_post_id", postIds),
    ]);

    const existingSet = new Set((existingJobs||[]).map(j => j.tracktik_post_id));
    const newPostIds  = postIds.filter(id => !existingSet.has(id));

    const snapshot = {
      post_ids: postIds, new_post_ids: newPostIds,
      jobs: existingJobs||[], cycles: existingCycles||[], history: existingHistory||[],
    };

    // ── Step 1: Delete only CSV-sourced cycles for these IDs ──
    // GHL cycles (source='ghl') are preserved
    await supabase
      .from("job_cycles")
      .delete()
      .in("tracktik_post_id", postIds)
      .eq("source", "csv");

    // Also delete CSV-sourced history
    await supabase
      .from("job_status_history")
      .delete()
      .in("tracktik_post_id", postIds)
      .filter("raw_payload->>source", "eq", "csv_import");

    // ── Step 2: Process each job ──────────────────────────
    const jobUpserts     = [];
    const cycleInserts   = [];
    const historyInserts = [];

    let filledCount = 0, withdrawnCount = 0, openCount = 0;
    let reviewCount = 0;

    for (const [trackTikPostId, groupRows] of groups.entries()) {
      const sortedRows = [...groupRows].sort(
        (a,b) => parseDate(a["Job Date Created"]) - parseDate(b["Job Date Created"])
      );
      const earliest = sortedRows[0];
      const latest   = sortedRows[sortedRows.length - 1];
      const cycles   = computeCycles(groupRows);

      const lastCycle     = cycles[cycles.length - 1];
      const currentStatus = lastCycle?.reason === "still_open" ? "open" : "closed";

      // Only insert new jobs — don't overwrite existing GHL data
      if (!existingSet.has(trackTikPostId)) {
        jobUpserts.push({
          tracktik_post_id:         trackTikPostId,
          tracktik_site_id:         latest["TrackTik Site ID"]                  || null,
          site_name_position_shift: latest["Site Name - Position Type - Shift"] || null,
          region:                   normalizeRegion(latest["Region"]),
          hiring_manager:           normalizeManager(latest["Hiring Manager"]),
          officer_type:             normalizeOfficerType(latest["Officer Type"]),
          position_start_date:      latest["Position Start Date"]                || null,
          advertised_pay_rate:      latest["Salary Range"]                       || null,
          current_status:           currentStatus,
          total_cycles:             cycles.length,
          first_seen_at:            parseDate(earliest["Job Date Created"])?.toISOString() || new Date().toISOString(),
          created_at:               parseDate(earliest["Job Date Created"])?.toISOString() || new Date().toISOString(),
          updated_at:               new Date().toISOString(),
        });
      }

      // Check for discrepancies
      const notes = [];
      if (cycles.some(c => c.days_to_hire !== null && c.days_to_hire < 1))
        notes.push("cycle < 1 day");
      for (const r of groupRows) {
        if ((r["Hiring Manager"]||"").includes(","))
          notes.push(`combined manager: '${r["Hiring Manager"]}'`);
      }
      if (notes.length) reviewCount++;

      // Get GHL cycles for this job to determine starting cycle number
      const ghlCycles = (existingCycles||[]).filter(
        c => c.tracktik_post_id === trackTikPostId && c.source === "ghl"
      );
      const maxGhlCycle = ghlCycles.length > 0
        ? Math.max(...ghlCycles.map(c => c.cycle_number))
        : 0;

      const totalFilledDays = cycles
        .filter(c => c.reason === "filled" && c.days_to_hire !== null)
        .reduce((s,c) => s + c.days_to_hire, 0);

      cycles.forEach((c, i) => {
        const cycleNum = maxGhlCycle + i + 1;
        const pct = (c.reason === "filled" && c.days_to_hire !== null && totalFilledDays > 0)
          ? round2((c.days_to_hire / totalFilledDays) * 100)
          : null;

        cycleInserts.push({
          tracktik_post_id: trackTikPostId,
          cycle_number:     cycleNum,
          opened_at:        c.opened_at?.toISOString()  || null,
          closed_at:        c.closed_at?.toISOString()  || null,
          days_to_hire:     c.days_to_hire,
          pct_time_to_hire: pct,
          is_open:          c.closed_at === null,
          source:           "csv",
        });

        historyInserts.push({
          tracktik_post_id: trackTikPostId,
          status:           "open",
          cycle_number:     cycleNum,
          recorded_at:      c.opened_at?.toISOString() || new Date().toISOString(),
          raw_payload:      { source:"csv_import", filename },
        });

        if (c.closed_at) {
          historyInserts.push({
            tracktik_post_id: trackTikPostId,
            status:           "closed",
            cycle_number:     cycleNum,
            recorded_at:      c.closed_at.toISOString(),
            raw_payload:      { source:"csv_import", filename, reason: c.reason },
          });
        }

        if (c.reason === "filled")     filledCount++;
        else if (c.reason === "withdrawn") withdrawnCount++;
        else openCount++;
      });
    }

    // ── Step 3: Bulk insert (batches of 200) ──────────────
    if (jobUpserts.length) {
      const { error } = await supabase.from("job_requisitions").upsert(jobUpserts, { onConflict:"tracktik_post_id" });
      if (error) throw new Error("Insert jobs: " + error.message);
    }

    for (let i = 0; i < cycleInserts.length; i += 200) {
      const { error } = await supabase.from("job_cycles").insert(cycleInserts.slice(i, i+200));
      if (error) throw new Error("Insert cycles: " + error.message);
    }

    for (let i = 0; i < historyInserts.length; i += 200) {
      const { error } = await supabase.from("job_status_history").insert(historyInserts.slice(i, i+200));
      if (error) throw new Error("Insert history: " + error.message);
    }

    // ── Step 4: Update total_cycles per job ───────────────
    // Bulk update using a single query
    const { data: cycleCounts } = await supabase
      .from("job_cycles")
      .select("tracktik_post_id")
      .in("tracktik_post_id", postIds);

    const countMap = {};
    (cycleCounts||[]).forEach(c => {
      countMap[c.tracktik_post_id] = (countMap[c.tracktik_post_id]||0) + 1;
    });

    for (const [tid, cnt] of Object.entries(countMap)) {
      await supabase.from("job_requisitions")
        .update({ total_cycles: cnt, updated_at: new Date().toISOString() })
        .eq("tracktik_post_id", tid);
    }

    // ── Step 5: Record batch ──────────────────────────────
    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        filename,
        total_jobs:   groups.size,
        total_cycles: cycleInserts.length,
        status:       "completed",
        snapshot,
      })
      .select().single();
    if (batchErr) throw new Error("Record batch: " + batchErr.message);

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({
        success:           true,
        batch_id:          batch.id,
        csv_rows:          rows.length,
        jobs_processed:    groups.size,
        new_jobs:          newPostIds.length,
        existing_jobs:     groups.size - newPostIds.length,
        new_cycles:        cycleInserts.length,
        skipped_cycles:    0,
        filled_cycles:     filledCount,
        withdrawn_cycles:  withdrawnCount,
        still_open_cycles: openCount,
        needs_review:      reviewCount,
      }),
    };

  } catch(err) {
    console.error("[Import Error]", err.message);
    return {
      statusCode: 500,
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
