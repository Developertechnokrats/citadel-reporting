// netlify/functions/import-csv.js
// ── KEY CHANGES FROM PREVIOUS VERSION ────────────────────────
// 1. Uses "TrackTik Post ID" column directly (no Job ID stripping)
// 2. MERGE logic: skips cycles already in DB (within 24hr window)
//    preserves GHL live webhook data (Jun 11-21)
// 3. Does NOT overwrite job field values if job already exists
//    (GHL version wins for site name, region, manager etc.)
// 4. Tags discrepancies with needs_review = true + review_notes
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

// Normalise manager name — fix known casing/typo variants
function normalizeManager(name) {
  if (!name) return null;
  const fixes = {
    "brandon soll":           "Brandon Soll",
    "heather jordan":         "Heather Jordan",
    "kaithlyn antolic":       "Kaitlyn Antolic",
    "spencer lane, heather jordan": "Spencer Lane",  // combined field → pick primary
  };
  const key = name.trim().toLowerCase();
  return fixes[key] || name.trim();
}

// Check if two dates are within 24 hours of each other
function within24hrs(d1, d2) {
  if (!d1 || !d2) return false;
  return Math.abs(new Date(d1) - new Date(d2)) <= 24 * 60 * 60 * 1000;
}

// ── Cycle detection ───────────────────────────────────────────
function computeCycles(rowsForId) {
  const sorted = [...rowsForId].sort(
    (a,b) => parseDate(a["Job Date Created"]) - parseDate(b["Job Date Created"])
  );
  const cycles = [];
  let cycleOpen = null;
  let lastRepostOpen = null;
  const n = sorted.length;

  sorted.forEach((r, i) => {
    if (cycleOpen === null) cycleOpen = parseDate(r["Job Date Created"]);
    lastRepostOpen = parseDate(r["Job Date Created"]);
    const stage  = r["Job Stage Name"];
    const isLast = i === n - 1;

    if (stage === "Position Filled") {
      const close = parseDate(r["Job Last Modified"]);
      let days = parseTimeToFill(r["Time to Fill"]);
      if (days === null && lastRepostOpen && close)
        days = round2((close - lastRepostOpen) / (1000*60*60*24));
      cycles.push({ opened_at:cycleOpen, closed_at:close, days_to_hire:days, reason:"filled" });
      cycleOpen = null; lastRepostOpen = null;
    } else if (stage === "Withdrawn" && isLast) {
      cycles.push({ opened_at:cycleOpen, closed_at:parseDate(r["Job Last Modified"]), days_to_hire:null, reason:"withdrawn" });
      cycleOpen = null;
    }
    // Indeed Refresh / Posted / mid-stream Withdrawn → ignored
  });

  if (cycleOpen !== null)
    cycles.push({ opened_at:cycleOpen, closed_at:null, days_to_hire:null, reason:"still_open" });

  return cycles;
}

// ── Discrepancy detector ──────────────────────────────────────
function detectDiscrepancies(trackTikPostId, csvRows, csvCycles, existingCycles) {
  const notes = [];

  // Check if Job ID stripping would have given a different base ID
  for (const r of csvRows) {
    const jobId = r["Job ID"] || "";
    const m = jobId.match(/^(.*?)[A-Z]?\d{2}$/i);
    const stripped = m ? m[1] : jobId;
    if (stripped !== trackTikPostId && stripped !== "") {
      notes.push(`Job ID suffix stripping gives '${stripped}' but TrackTik Post ID is '${trackTikPostId}'`);
      break;
    }
  }

  // Check for very short cycles (< 1 day) — may indicate data issue
  const shortCycles = csvCycles.filter(c => c.days_to_hire !== null && c.days_to_hire < 1);
  if (shortCycles.length > 0)
    notes.push(`${shortCycles.length} cycle(s) with < 1 day to hire — verify data`);

  // Check for duplicate open dates with existing
  for (const csvCycle of csvCycles) {
    const conflict = existingCycles.find(ec =>
      within24hrs(ec.opened_at, csvCycle.opened_at) && !ec.is_open
    );
    if (conflict)
      notes.push(`CSV cycle (${csvCycle.opened_at?.toISOString().slice(0,10)}) overlaps existing closed cycle`);
  }

  // Combined manager name in CSV (e.g. "Spencer Lane, Heather Jordan")
  for (const r of csvRows) {
    if ((r["Hiring Manager"] || "").includes(","))
      notes.push(`Combined manager name detected: '${r["Hiring Manager"]}'`);
  }

  return notes;
}

// ── Main handler ──────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== "POST")
    return { statusCode:405, body:JSON.stringify({ error:"Method not allowed" }) };

  // ── Parse request — supports both JSON and multipart FormData ──
  let filename = "upload.csv";
  let csvText  = "";

  try {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (contentType.includes("multipart/form-data")) {
      const boundary = contentType.split("boundary=")[1];
      const bodyStr  = Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8").toString("utf8");
      const fnMatch  = bodyStr.match(/filename="([^"]+)"/);
      if (fnMatch) filename = fnMatch[1];
      const parts = bodyStr.split("--" + boundary);
      for (const part of parts) {
        if (part.includes("Content-Type:") || part.includes('name="file"')) {
          const start = part.indexOf("\r\n\r\n");
          if (start !== -1) { csvText = part.slice(start + 4).replace(/\r\n--[\s\S]*$/, "").trim(); break; }
        }
      }
    } else {
      const body = JSON.parse(event.body);
      filename   = body.filename || "upload.csv";
      csvText    = body.csv || "";
    }
  } catch(e) {
    return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"Parse error: "+e.message }) };
  }

  if (!csvText) return { statusCode:400, headers:{"Content-Type":"application/json"}, body:JSON.stringify({ error:"No CSV content received" }) };

  let rows;
  try { rows = parse(csvText, { columns:true, skip_empty_lines:true }); }
  catch(e) { return { statusCode:400, body:JSON.stringify({ error:"Cannot parse CSV: "+e.message }) }; }

  if (!rows.length) return { statusCode:400, body:JSON.stringify({ error:"CSV is empty" }) };

  // Validate required columns
  const required = ["TrackTik Post ID","Job ID","Job Date Created","Job Last Modified","Job Stage Name"];
  const missing  = required.filter(c => !(c in rows[0]));
  if (missing.length)
    return { statusCode:400, body:JSON.stringify({ error:"Missing columns: "+missing.join(", ") }) };

  // ── Group by TrackTik Post ID (direct from column) ────────
  const groups = new Map();
  for (const r of rows) {
    const tid = (r["TrackTik Post ID"] || "").trim();
    if (!tid) continue;
    if (!groups.has(tid)) groups.set(tid, []);
    groups.get(tid).push(r);
  }

  const postIds = [...groups.keys()];

  try {
    // ── Snapshot existing data for undo ────────────────────
    const { data: existingJobs }    = await supabase.from("job_requisitions").select("*").in("tracktik_post_id", postIds);
    const { data: existingCycles }  = await supabase.from("job_cycles").select("*").in("tracktik_post_id", postIds);
    const { data: existingHistory } = await supabase.from("job_status_history").select("*").in("tracktik_post_id", postIds);

    const existingJobMap   = new Map((existingJobs   || []).map(j => [j.tracktik_post_id, j]));
    const existingCycleMap = new Map();
    for (const c of (existingCycles || [])) {
      if (!existingCycleMap.has(c.tracktik_post_id))
        existingCycleMap.set(c.tracktik_post_id, []);
      existingCycleMap.get(c.tracktik_post_id).push(c);
    }

    const existingSet = new Set(existingJobMap.keys());
    const newPostIds  = postIds.filter(id => !existingSet.has(id));

    const snapshot = {
      post_ids: postIds, new_post_ids: newPostIds,
      jobs: existingJobs || [], cycles: existingCycles || [], history: existingHistory || [],
    };

    // ── Process each job ────────────────────────────────────
    let totalNewCycles = 0, totalSkippedCycles = 0;
    let filledCount = 0, withdrawnCount = 0, openCount = 0;
    let reviewCount = 0;

    for (const [trackTikPostId, groupRows] of groups.entries()) {
      const sortedByDate = [...groupRows].sort(
        (a,b) => parseDate(a["Job Date Created"]) - parseDate(b["Job Date Created"])
      );
      const earliest  = sortedByDate[0];
      const latest    = sortedByDate[sortedByDate.length-1];
      const csvCycles = computeCycles(groupRows);
      const existing  = existingJobMap.get(trackTikPostId);
      const existingCyclesForJob = existingCycleMap.get(trackTikPostId) || [];

      // ── Detect discrepancies ──────────────────────────────
      const discrepancies = detectDiscrepancies(trackTikPostId, groupRows, csvCycles, existingCyclesForJob);
      const needsReview   = discrepancies.length > 0;
      const reviewNotes   = discrepancies.join(" | ") || null;

      // ── Upsert job_requisitions ───────────────────────────
      // If job already exists → only update status + review flags (don't touch field values)
      // If new → insert everything
      if (!existing) {
        const lastCycle     = csvCycles[csvCycles.length-1];
        const currentStatus = lastCycle?.reason === "still_open" ? "open" : "closed";

        const { error: insertErr } = await supabase.from("job_requisitions").insert({
          tracktik_post_id:         trackTikPostId,
          tracktik_site_id:         latest["TrackTik Site ID"]                  || null,
          site_name_position_shift: latest["Site Name - Position Type - Shift"] || null,
          region:                   normalizeRegion(latest["Region"]),
          hiring_manager:           normalizeManager(latest["Hiring Manager"]),
          officer_type:             normalizeOfficerType(latest["Officer Type"]),
          position_start_date:      latest["Position Start Date"]                || null,
          advertised_pay_rate:      latest["Salary Range"]                       || null,
          current_status:           currentStatus,
          total_cycles:             csvCycles.length,
          first_seen_at:            parseDate(earliest["Job Date Created"]).toISOString(),
          created_at:               parseDate(earliest["Job Date Created"]).toISOString(),
          updated_at:               new Date().toISOString(),
          needs_review:             needsReview,
          review_notes:             reviewNotes,
        });
        if (insertErr) throw new Error(`Insert job: ${insertErr.message}`);
      } else {
        // Job exists — only update review flags + total_cycles (don't overwrite GHL data)
        const { error: updateErr } = await supabase.from("job_requisitions").update({
          needs_review: needsReview || existing.needs_review,
          review_notes: [existing.review_notes, reviewNotes].filter(Boolean).join(" | ") || null,
          updated_at:   new Date().toISOString(),
        }).eq("tracktik_post_id", trackTikPostId);
        if (updateErr) throw new Error(`Update job: ${updateErr.message}`);
      }

      if (needsReview) reviewCount++;

      // ── Merge cycles ──────────────────────────────────────
      // For each CSV cycle, check if a matching cycle already exists in DB
      // Match = opened_at within 24 hours of each other
      // If match found → skip (preserve GHL data)
      // If no match → insert as new cycle

      // Determine next cycle number (after existing ones)
      let nextCycleNum = existingCyclesForJob.length > 0
        ? Math.max(...existingCyclesForJob.map(c => c.cycle_number)) + 1
        : 1;

      const totalFilledDays = csvCycles
        .filter(c => c.reason==="filled" && c.days_to_hire!==null)
        .reduce((s,c) => s+c.days_to_hire, 0);

      for (const csvCycle of csvCycles) {
        // Check for existing cycle within 24hr window
        const alreadyExists = existingCyclesForJob.some(ec =>
          within24hrs(ec.opened_at, csvCycle.opened_at)
        );

        if (alreadyExists) {
          totalSkippedCycles++;
          continue; // preserve GHL live data
        }

        // Insert new cycle
        const cycleNum = nextCycleNum++;
        const pct = (csvCycle.reason==="filled" && csvCycle.days_to_hire!==null && totalFilledDays>0)
          ? round2((csvCycle.days_to_hire/totalFilledDays)*100)
          : null;

        const { error: cycleErr } = await supabase.from("job_cycles").insert({
          tracktik_post_id: trackTikPostId,
          cycle_number:     cycleNum,
          opened_at:        csvCycle.opened_at?.toISOString()  || null,
          closed_at:        csvCycle.closed_at?.toISOString()  || null,
          days_to_hire:     csvCycle.days_to_hire,
          pct_time_to_hire: pct,
          is_open:          csvCycle.closed_at === null,
        });
        if (cycleErr) throw new Error(`Insert cycle: ${cycleErr.message}`);

        // History: open event
        await supabase.from("job_status_history").insert({
          tracktik_post_id: trackTikPostId,
          status:           "open",
          cycle_number:     cycleNum,
          recorded_at:      csvCycle.opened_at?.toISOString() || new Date().toISOString(),
          raw_payload:      { source:"csv_import", filename },
        });

        if (csvCycle.closed_at) {
          await supabase.from("job_status_history").insert({
            tracktik_post_id: trackTikPostId,
            status:           "closed",
            cycle_number:     cycleNum,
            recorded_at:      csvCycle.closed_at.toISOString(),
            raw_payload:      { source:"csv_import", filename, reason:csvCycle.reason },
          });
        }

        totalNewCycles++;
        if (csvCycle.reason==="filled")     filledCount++;
        else if (csvCycle.reason==="withdrawn") withdrawnCount++;
        else openCount++;
      }

      // Update total_cycles count on the job
      const { data: allCyclesNow } = await supabase.from("job_cycles")
        .select("cycle_number").eq("tracktik_post_id", trackTikPostId);
      await supabase.from("job_requisitions").update({
        total_cycles: (allCyclesNow||[]).length,
      }).eq("tracktik_post_id", trackTikPostId);
    }

    // ── Record batch for undo ──────────────────────────────
    const { data: batch, error: batchErr } = await supabase
      .from("import_batches")
      .insert({
        filename:     filename || "upload.csv",
        total_jobs:   groups.size,
        total_cycles: totalNewCycles,
        status:       "completed",
        snapshot,
      })
      .select().single();
    if (batchErr) throw new Error(`Record batch: ${batchErr.message}`);

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
        new_cycles:        totalNewCycles,
        skipped_cycles:    totalSkippedCycles,
        filled_cycles:     filledCount,
        withdrawn_cycles:  withdrawnCount,
        still_open_cycles: openCount,
        needs_review:      reviewCount,
      }),
    };

  } catch (err) {
    console.error("[Import Error]", err.message);
    return {
      statusCode: 500,
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
