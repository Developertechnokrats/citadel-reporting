// netlify/functions/edit-cycles.js
// ─────────────────────────────────────────────────────────────
// Admin-only: create / update / delete job cycles manually.
// Every operation is logged to manual_corrections for audit.
// Called from admin.html — protected by client-side login gate.
// ─────────────────────────────────────────────────────────────

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function round2(n) { return Math.round(n * 100) / 100; }

function calcDays(openedAt, closedAt) {
  if (!openedAt || !closedAt) return null;
  const diff = new Date(closedAt) - new Date(openedAt);
  return diff > 0 ? round2(diff / (1000 * 60 * 60 * 24)) : 0;
}

function parseInputDate(str) {
  if (!str || !str.trim()) return null;
  // Accept MM/DD/YYYY or YYYY-MM-DD
  const us = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (us) {
    const [, mm, dd, yyyy] = us;
    return new Date(`${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}T12:00:00.000Z`).toISOString();
  }
  const iso = str.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return new Date(str.trim() + "T12:00:00.000Z").toISOString();
  return null;
}

async function recalcPct(tracktikPostId) {
  const { data: cycles } = await supabase
    .from("job_cycles")
    .select("id, cycle_number, days_to_hire")
    .eq("tracktik_post_id", tracktikPostId)
    .not("days_to_hire", "is", null);

  const total = (cycles || []).reduce((s, c) => s + parseFloat(c.days_to_hire), 0);
  if (total <= 0) return;

  for (const c of (cycles || [])) {
    const pct = round2((parseFloat(c.days_to_hire) / total) * 100);
    await supabase.from("job_cycles").update({ pct_time_to_hire: pct }).eq("id", c.id);
  }
}

async function updateJobMeta(tracktikPostId) {
  const { data: cycles } = await supabase
    .from("job_cycles")
    .select("cycle_number, is_open")
    .eq("tracktik_post_id", tracktikPostId);

  const total       = (cycles || []).length;
  const anyOpen     = (cycles || []).some(c => c.is_open);
  const newStatus   = anyOpen ? "open" : "closed";

  await supabase.from("job_requisitions").update({
    total_cycles:   total,
    current_status: newStatus,
    updated_at:     new Date().toISOString(),
  }).eq("tracktik_post_id", tracktikPostId);
}

async function logCorrection(tracktikPostId, type, cycleNum, before, after, note) {
  await supabase.from("manual_corrections").insert({
    tracktik_post_id: tracktikPostId,
    correction_type:  type,
    cycle_number:     cycleNum,
    before_state:     before || null,
    after_state:      after  || null,
    note:             note   || null,
    corrected_by:     "admin",
  });
}

// ── Handlers ──────────────────────────────────────────────────

async function handleUpdate(body) {
  const { tracktik_post_id, cycle_number, opened_at, closed_at, note } = body;

  const openedIso = parseInputDate(opened_at);
  const closedIso = parseInputDate(closed_at);
  const days      = calcDays(openedIso, closedIso);
  const isOpen    = !closedIso;

  // Snapshot before state
  const { data: before } = await supabase
    .from("job_cycles")
    .select("*")
    .eq("tracktik_post_id", tracktik_post_id)
    .eq("cycle_number", cycle_number)
    .single();

  if (!before) return { error: `Cycle #${cycle_number} not found for ${tracktik_post_id}` };

  const after = { opened_at: openedIso, closed_at: closedIso, days_to_hire: days, is_open: isOpen };

  const { error } = await supabase
    .from("job_cycles")
    .update({ opened_at: openedIso, closed_at: closedIso || null, days_to_hire: days, is_open: isOpen, updated_at: new Date().toISOString() })
    .eq("tracktik_post_id", tracktik_post_id)
    .eq("cycle_number", cycle_number);

  if (error) return { error: error.message };

  await recalcPct(tracktik_post_id);
  await updateJobMeta(tracktik_post_id);
  await logCorrection(tracktik_post_id, "cycle_edit", cycle_number, before, after, note);

  return { success: true, action: "updated", tracktik_post_id, cycle_number, days_to_hire: days };
}

async function handleAdd(body) {
  const { tracktik_post_id, opened_at, closed_at, note } = body;

  const openedIso = parseInputDate(opened_at);
  const closedIso = parseInputDate(closed_at);
  const days      = calcDays(openedIso, closedIso);
  const isOpen    = !closedIso;

  // Determine next cycle number
  const { data: existing } = await supabase
    .from("job_cycles")
    .select("cycle_number")
    .eq("tracktik_post_id", tracktik_post_id)
    .order("cycle_number", { ascending: false })
    .limit(1);

  const newCycleNum = existing && existing.length > 0 ? existing[0].cycle_number + 1 : 1;

  const { error } = await supabase.from("job_cycles").insert({
    tracktik_post_id, cycle_number: newCycleNum,
    opened_at: openedIso, closed_at: closedIso || null,
    days_to_hire: days, is_open: isOpen, source: "manual",
  });

  if (error) return { error: error.message };

  await recalcPct(tracktik_post_id);
  await updateJobMeta(tracktik_post_id);
  await logCorrection(tracktik_post_id, "cycle_add", newCycleNum, null,
    { opened_at: openedIso, closed_at: closedIso, days_to_hire: days }, note);

  return { success: true, action: "added", tracktik_post_id, cycle_number: newCycleNum, days_to_hire: days };
}

async function handleDelete(body) {
  const { tracktik_post_id, cycle_number, note } = body;

  const { data: before } = await supabase
    .from("job_cycles")
    .select("*")
    .eq("tracktik_post_id", tracktik_post_id)
    .eq("cycle_number", cycle_number)
    .single();

  if (!before) return { error: `Cycle #${cycle_number} not found` };

  const { error } = await supabase
    .from("job_cycles")
    .delete()
    .eq("tracktik_post_id", tracktik_post_id)
    .eq("cycle_number", cycle_number);

  if (error) return { error: error.message };

  // Renumber remaining cycles
  const { data: remaining } = await supabase
    .from("job_cycles")
    .select("id, cycle_number")
    .eq("tracktik_post_id", tracktik_post_id)
    .order("cycle_number", { ascending: true });

  for (let i = 0; i < (remaining || []).length; i++) {
    await supabase.from("job_cycles").update({ cycle_number: i + 1 }).eq("id", remaining[i].id);
  }

  await recalcPct(tracktik_post_id);
  await updateJobMeta(tracktik_post_id);
  await logCorrection(tracktik_post_id, "cycle_delete", cycle_number, before, null, note);

  return { success: true, action: "deleted", tracktik_post_id, cycle_number };
}

async function handleBulk(body) {
  const { rows, note } = body; // rows: [{tracktik_post_id, cycle_number, opened_at, closed_at}]
  const results = [];

  for (const row of rows) {
    const { tracktik_post_id, cycle_number, opened_at, closed_at } = row;
    if (!tracktik_post_id) continue;

    const openedIso = parseInputDate(opened_at);
    const closedIso = parseInputDate(closed_at);
    const days      = calcDays(openedIso, closedIso);
    const isOpen    = !closedIso;

    if (cycle_number) {
      // Update existing cycle
      const { data: before } = await supabase.from("job_cycles").select("*")
        .eq("tracktik_post_id", tracktik_post_id).eq("cycle_number", cycle_number).single();

      const { error } = await supabase.from("job_cycles").update({
        opened_at: openedIso, closed_at: closedIso || null,
        days_to_hire: days, is_open: isOpen, updated_at: new Date().toISOString(),
      }).eq("tracktik_post_id", tracktik_post_id).eq("cycle_number", cycle_number);

      await logCorrection(tracktik_post_id, "bulk_import", cycle_number, before || null,
        { opened_at: openedIso, closed_at: closedIso, days_to_hire: days }, note || "bulk edit");
      results.push({ tracktik_post_id, cycle_number, action: error ? "error" : "updated", error: error?.message });
    } else {
      // Add new cycle
      const { data: existing } = await supabase.from("job_cycles").select("cycle_number")
        .eq("tracktik_post_id", tracktik_post_id).order("cycle_number", { ascending: false }).limit(1);
      const newNum = existing && existing.length > 0 ? existing[0].cycle_number + 1 : 1;

      const { error } = await supabase.from("job_cycles").insert({
        tracktik_post_id, cycle_number: newNum,
        opened_at: openedIso, closed_at: closedIso || null,
        days_to_hire: days, is_open: isOpen, source: "manual",
      });

      await logCorrection(tracktik_post_id, "bulk_import", newNum, null,
        { opened_at: openedIso, closed_at: closedIso, days_to_hire: days }, note || "bulk edit");
      results.push({ tracktik_post_id, cycle_number: newNum, action: error ? "error" : "added", error: error?.message });
    }
  }

  // Recalc all affected jobs
  const affectedIds = [...new Set(rows.map(r => r.tracktik_post_id).filter(Boolean))];
  for (const id of affectedIds) {
    await recalcPct(id);
    await updateJobMeta(id);
  }

  return { success: true, action: "bulk", results };
}

async function handleGetCorrections(tracktikPostId) {
  const { data, error } = await supabase
    .from("manual_corrections")
    .select("*")
    .eq("tracktik_post_id", tracktikPostId)
    .order("created_at", { ascending: false });

  if (error) return { error: error.message };
  return { corrections: data || [] };
}

// ── Main handler ──────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  try {
    // GET corrections history
    if (event.httpMethod === "GET") {
      const { tracktik_post_id } = event.queryStringParameters || {};
      if (!tracktik_post_id) return { statusCode: 400, headers, body: JSON.stringify({ error: "tracktik_post_id required" }) };
      const result = await handleGetCorrections(tracktik_post_id);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

    const body = JSON.parse(event.body || "{}");
    const { action } = body;
    let result;

    if (action === "update") result = await handleUpdate(body);
    else if (action === "add")    result = await handleAdd(body);
    else if (action === "delete") result = await handleDelete(body);
    else if (action === "bulk")   result = await handleBulk(body);
    else return { statusCode: 400, headers, body: JSON.stringify({ error: "Unknown action. Use: update | add | delete | bulk" }) };

    if (result.error) return { statusCode: 400, headers, body: JSON.stringify({ error: result.error }) };
    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    console.error("[edit-cycles error]", err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
