// netlify/functions/job-detail.js
// Returns full detail for a single TrackTik Post ID

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const { tracktik_post_id } = event.queryStringParameters || {};

  if (!tracktik_post_id) {
    return { statusCode: 400, body: JSON.stringify({ error: "tracktik_post_id is required" }) };
  }

  try {
    // Full job record
    const { data: job, error: jobErr } = await supabase
      .from("job_requisitions")
      .select("*")
      .eq("tracktik_post_id", tracktik_post_id)
      .single();

    if (jobErr) throw new Error(`Job fetch: ${jobErr.message}`);
    if (!job) return { statusCode: 404, body: JSON.stringify({ error: "Job not found" }) };

    // All cycles
    const { data: cycles, error: cyclesErr } = await supabase
      .from("job_cycles")
      .select("*")
      .eq("tracktik_post_id", tracktik_post_id)
      .order("cycle_number", { ascending: true });

    if (cyclesErr) throw new Error(`Cycles fetch: ${cyclesErr.message}`);

    // Full status history
    const { data: history, error: histErr } = await supabase
      .from("job_status_history")
      .select("id, status, cycle_number, recorded_at")
      .eq("tracktik_post_id", tracktik_post_id)
      .order("recorded_at", { ascending: true });

    if (histErr) throw new Error(`History fetch: ${histErr.message}`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ job, cycles: cycles || [], history: history || [] }),
    };

  } catch (err) {
    console.error(`[Job Detail Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
