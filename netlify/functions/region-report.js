// netlify/functions/region-report.js
// Aggregate Time-to-Hire report filtered by Region + date range.
//
// A cycle is INCLUDED if:
//   - it belongs to a job in the selected region
//   - it is a CLOSED cycle with a valid days_to_hire (i.e. "filled")
//   - opened_at >= date_from  AND  closed_at <= date_to
//     (the entire cycle must fall within the selected window)

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const { region, date_from, date_to } = event.queryStringParameters || {};

  if (!region || !date_from || !date_to) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "region, date_from and date_to are all required" }),
    };
  }

  try {
    // Build inclusive date boundaries
    const fromIso = new Date(date_from + "T00:00:00.000Z").toISOString();
    const toDate  = new Date(date_to + "T00:00:00.000Z");
    toDate.setUTCHours(23, 59, 59, 999);
    const toIso = toDate.toISOString();

    // Pull all closed, "filled" cycles (days_to_hire not null) for jobs in this region,
    // where the cycle is fully contained within [date_from, date_to]
    const { data: cycles, error } = await supabase
      .from("job_cycles")
      .select(`
        tracktik_post_id, cycle_number, opened_at, closed_at, days_to_hire, pct_time_to_hire,
        job_requisitions!inner (
          tracktik_post_id, site_name_position_shift, region,
          hiring_manager, officer_type, current_status
        )
      `)
      .eq("job_requisitions.region", region)
      .not("days_to_hire", "is", null)
      .gte("opened_at", fromIso)
      .lte("closed_at", toIso)
      .order("opened_at", { ascending: true });

    if (error) throw new Error(`Query: ${error.message}`);

    const list = cycles || [];

    const totalDays = list.reduce((sum, c) => sum + Number(c.days_to_hire || 0), 0);
    const avgDays   = list.length ? totalDays / list.length : 0;

    const totalPct  = list.reduce((sum, c) => sum + Number(c.pct_time_to_hire || 0), 0);
    const avgPct    = list.length ? totalPct / list.length : 0;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        region,
        date_from,
        date_to,
        summary: {
          total_cycles:        list.length,
          accumulated_days:    Math.round(totalDays * 100) / 100,
          avg_days_to_hire:    Math.round(avgDays * 100) / 100,
          avg_pct_time_to_hire: Math.round(avgPct * 100) / 100,
        },
        cycles: list,
      }),
    };

  } catch (err) {
    console.error(`[Region Report Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
