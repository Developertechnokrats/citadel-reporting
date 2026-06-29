// netlify/functions/job-requisition.js
// Receives GHL Job Requisition webhooks and processes them

const { createClient } = require("@supabase/supabase-js");

// ── Supabase client ─────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // use service_role key for full access
);

// ── Helpers ──────────────────────────────────────────────────
// Convert snake_case or lowercase names to Title Case
// e.g. "heather_jordan" → "Heather Jordan"
//      "jeff_patton"    → "Jeff Patton"
function toTitleCase(str) {
  if (!str || typeof str !== "string") return str;
  return str
    .replace(/_/g, " ")
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

// ── Field mapper: GHL JSON → DB columns ─────────────────────
function mapPayloadToRecord(payload) {
  return {
    tracktik_post_id:              payload["TrackTik Post ID"],
    ghl_id:                        payload["ID"],
    advertised_pay_rate:           payload["Advertised Pay Rate"],
    applicant_radius:              payload["Applicant Radius"],
    applicant_stack_status:        payload["Applicant Stack Status"],
    city_of_site_location:         payload["City of the Site Location"],
    disqualifying_questions:       payload["Disqualifying Questions"],
    employment_status:             payload["Employment Status"],
    hiring_manager:                toTitleCase(payload["Hiring Manager"]),
    hr_approval_status:            payload["HR Approval Status"],
    in_person_interview_address:   payload["In-Person Interview Physical Address"],
    industry:                      payload["Industry"],
    interview_calendar:            payload["Interview Calendar for Position"],
    interview_type:                payload["Interview Type"],
    job_duties:                    payload["Job Duties And Other Information Specific To This Position"],
    officer_type:                  payload["Officer Type"],
    other_preferences:             payload["Other Preferences (MUST be relevant to the position)"],
    position_specific_requirements: payload["Position Specific Requirements"],
    position_start_date:           payload["Position Start Date/Fill By Date"],
    position_status:               payload["Position Status"],
    preferred_screening_questions: payload["Preferred Screening Questions"],
    region:                        payload["Region"],
    schedule:                      payload["Schedule"],
    serviceable_zip_code:          payload["Serviceable Zip Code"],
    site_name_position_shift:      payload["Site Name - Position Type - Shift"],
    state_of_site_location:        payload["State of the Site Location"],
    tier1_zip_codes:               payload["Tier 1 Zip Codes"],
    tier2_zip_codes:               payload["Tier 2 Zip Codes"],
    tier3_zip_codes:               payload["Tier 3 Zip Codes"],
    tracktik_site_id:              payload["TrackTik Site ID"],
    zip_code_of_site:              String(payload["Zip Code of Site Location"] || ""),
    current_status:                (payload["Operational Job Status"] || "created").toLowerCase(),
    updated_at:                    new Date().toISOString(),
  };
}

// ── Main handler ─────────────────────────────────────────────
exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Validate webhook secret (optional but recommended)
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const incomingSecret = event.headers["x-webhook-secret"] || event.headers["X-Webhook-Secret"];
    if (incomingSecret !== webhookSecret) {
      console.error("Invalid webhook secret");
      return { statusCode: 401, body: JSON.stringify({ error: "Unauthorized" }) };
    }
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const tracktikPostId = payload["TrackTik Post ID"];
  if (!tracktikPostId) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing TrackTik Post ID" }) };
  }

  const incomingStatus = (payload["Operational Job Status"] || "").toLowerCase();
  const now = new Date().toISOString();

  console.log(`[Webhook] TrackTik: ${tracktikPostId} | Status: ${incomingStatus}`);

  try {
    // ── STEP 1: Check if this job exists already ─────────────
    const { data: existingJob } = await supabase
      .from("job_requisitions")
      .select("tracktik_post_id, current_status, total_cycles")
      .eq("tracktik_post_id", tracktikPostId)
      .maybeSingle();

    const isNewJob = !existingJob;
    const recordData = mapPayloadToRecord(payload);

    // ── STEP 2: Upsert job_requisitions ──────────────────────
    if (isNewJob) {
      recordData.first_seen_at = now;
      recordData.created_at = now;
      recordData.total_cycles = 0;

      const { error: insertErr } = await supabase
        .from("job_requisitions")
        .insert(recordData);

      if (insertErr) throw new Error(`Insert job_requisitions: ${insertErr.message}`);
      console.log(`[DB] New job created: ${tracktikPostId}`);
    } else {
      const { error: updateErr } = await supabase
        .from("job_requisitions")
        .update({
          ...recordData,
          total_cycles: existingJob.total_cycles  // preserve cycle count, updated below
        })
        .eq("tracktik_post_id", tracktikPostId);

      if (updateErr) throw new Error(`Update job_requisitions: ${updateErr.message}`);
      console.log(`[DB] Job updated: ${tracktikPostId}`);
    }

    // ── STEP 3: Determine cycle number ───────────────────────
    let cycleNumber = null;

    if (incomingStatus === "open") {
      // Check if there is already an open (unclosed) cycle — avoid duplicates
      const { data: alreadyOpen } = await supabase
        .from("job_cycles")
        .select("cycle_number")
        .eq("tracktik_post_id", tracktikPostId)
        .eq("is_open", true)
        .limit(1)
        .maybeSingle();

      if (alreadyOpen) {
        // Cycle already open — reuse it, do not create a duplicate
        cycleNumber = alreadyOpen.cycle_number;
        console.log(`[DB] Cycle ${cycleNumber} already open for ${tracktikPostId} — skipping new cycle creation`);
      } else {
        // No open cycle exists — create a fresh one
        const newCycleNumber = (existingJob?.total_cycles || 0) + 1;
        cycleNumber = newCycleNumber;

        const { error: cycleInsertErr } = await supabase
          .from("job_cycles")
          .insert({
            tracktik_post_id: tracktikPostId,
            cycle_number: cycleNumber,
            opened_at: now,
            is_open: true,
          });

        if (cycleInsertErr) throw new Error(`Insert job_cycles: ${cycleInsertErr.message}`);

        await supabase
          .from("job_requisitions")
          .update({ total_cycles: newCycleNumber })
          .eq("tracktik_post_id", tracktikPostId);

        console.log(`[DB] Opened new cycle ${cycleNumber} for ${tracktikPostId}`);
      }

    } else if (incomingStatus === "closed") {
      // Find the latest open (unclosed) cycle
      const { data: openCycle, error: cycleErr } = await supabase
        .from("job_cycles")
        .select("*")
        .eq("tracktik_post_id", tracktikPostId)
        .eq("is_open", true)
        .order("cycle_number", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cycleErr) throw new Error(`Fetch open cycle: ${cycleErr.message}`);

      if (openCycle) {
        cycleNumber = openCycle.cycle_number;

        // Calculate days_to_hire
        const openedAt = new Date(openCycle.opened_at);
        const closedAt = new Date(now);
        const diffMs = closedAt - openedAt;
        const daysToHire = parseFloat((diffMs / (1000 * 60 * 60 * 24)).toFixed(2));

        // Close this cycle
        const { error: cycleUpdateErr } = await supabase
          .from("job_cycles")
          .update({
            closed_at: now,
            days_to_hire: daysToHire,
            is_open: false,
            updated_at: now,
          })
          .eq("tracktik_post_id", tracktikPostId)
          .eq("cycle_number", cycleNumber);

        if (cycleUpdateErr) throw new Error(`Close cycle: ${cycleUpdateErr.message}`);

        // Recalculate pct_time_to_hire for all cycles
        const { error: pctErr } = await supabase.rpc("recalculate_pct_time_to_hire", {
          p_tracktik_post_id: tracktikPostId,
        });

        if (pctErr) throw new Error(`Recalculate pct: ${pctErr.message}`);

        console.log(`[DB] Closed cycle ${cycleNumber} for ${tracktikPostId} — ${daysToHire} days`);
      } else {
        console.warn(`[DB] No open cycle found for ${tracktikPostId} on close event`);
      }
    }

    // ── STEP 4: Log to job_status_history ────────────────────
    // Every webhook hit is recorded — this is the full audit trail
    const historyStatus = isNewJob && !incomingStatus ? "created" : (incomingStatus || "created");

    const { error: histErr } = await supabase
      .from("job_status_history")
      .insert({
        tracktik_post_id: tracktikPostId,
        status:           historyStatus,
        cycle_number:     cycleNumber,
        recorded_at:      now,
        raw_payload:      payload,
      });

    if (histErr) throw new Error(`Insert job_status_history: ${histErr.message}`);

    // ── STEP 5: Return success ────────────────────────────────
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        success: true,
        tracktik_post_id: tracktikPostId,
        status: incomingStatus,
        cycle_number: cycleNumber,
        recorded_at: now,
      }),
    };

  } catch (err) {
    console.error(`[Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
