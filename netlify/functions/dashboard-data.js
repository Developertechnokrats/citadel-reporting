// netlify/functions/dashboard-data.js
// Uses two simple queries + JS join instead of unstable PostgREST !inner joins

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const q = event.queryStringParameters || {};
  const {
    tracktik_post_id, tracktik_site_id, status,
    region, city, hiring_manager, officer_type,
    date_from, date_to,
    page = "1", per_page = "50",
  } = q;

  const pageNum = Math.max(1, parseInt(page));
  const limit   = Math.min(100, Math.max(1, parseInt(per_page)));

  try {
    // ── Query 1: All job_requisitions (lightweight) ──────────
    let jobQuery = supabase
      .from("job_requisitions")
      .select(`
        tracktik_post_id, site_name_position_shift, region,
        city_of_site_location, hiring_manager, officer_type,
        current_status, total_cycles, tracktik_site_id,
        ghl_id, advertised_pay_rate, first_seen_at
      `);

    // Apply job-level filters
    if (status)         jobQuery = jobQuery.eq("current_status", status.toLowerCase());
    if (region)         jobQuery = jobQuery.ilike("region", `%${region}%`);
    if (city)           jobQuery = jobQuery.ilike("city_of_site_location", `%${city}%`);
    if (hiring_manager) jobQuery = jobQuery.ilike("hiring_manager", `%${hiring_manager}%`);
    if (officer_type)   jobQuery = jobQuery.ilike("officer_type", `%${officer_type}%`);
    if (tracktik_site_id) jobQuery = jobQuery.ilike("tracktik_site_id", `%${tracktik_site_id}%`);

    // ── Query 2: All job_cycles ───────────────────────────────
    let cycleQuery = supabase
      .from("job_cycles")
      .select("id, tracktik_post_id, cycle_number, opened_at, closed_at, days_to_hire, pct_time_to_hire, is_open")
      .order("opened_at", { ascending: false });

    // Apply cycle-level filters
    if (tracktik_post_id) cycleQuery = cycleQuery.ilike("tracktik_post_id", `%${tracktik_post_id.trim()}%`);
    if (date_from) cycleQuery = cycleQuery.gte("opened_at", new Date(date_from).toISOString());
    if (date_to) {
      const e = new Date(date_to); e.setHours(23,59,59,999);
      cycleQuery = cycleQuery.lte("opened_at", e.toISOString());
    }

    // ── Query 3: Filter options ───────────────────────────────
    const filterQuery = supabase
      .from("job_requisitions")
      .select("region, city_of_site_location, hiring_manager, officer_type, tracktik_site_id");

    // Run all 3 in parallel
    const [jobResult, cycleResult, filterResult] = await Promise.all([
      jobQuery, cycleQuery, filterQuery
    ]);

    if (jobResult.error)   throw new Error(`Jobs: ${jobResult.error.message}`);
    if (cycleResult.error) throw new Error(`Cycles: ${cycleResult.error.message}`);

    // ── Join in JavaScript ────────────────────────────────────
    const jobMap = new Map((jobResult.data || []).map(j => [j.tracktik_post_id, j]));

    // Filter cycles to only those whose job matches job-level filters
    const allCycles = (cycleResult.data || []).filter(c => jobMap.has(c.tracktik_post_id));

    // Paginate
    const total        = allCycles.length;
    const pagedCycles  = allCycles.slice((pageNum - 1) * limit, (pageNum - 1) * limit + limit);

    // Attach job details to each cycle
    const shapedCycles = pagedCycles.map(c => ({
      ...c,
      is_open: !!c.is_open,
      job_requisitions: jobMap.get(c.tracktik_post_id) || {},
    }));

    // ── Summary stats ─────────────────────────────────────────
    const filledDays = allCycles
      .filter(c => c.days_to_hire !== null)
      .map(c => parseFloat(c.days_to_hire));

    const avgDaysToHire = filledDays.length > 0
      ? parseFloat((filledDays.reduce((a,b) => a+b, 0) / filledDays.length).toFixed(1))
      : 0;

    // Unique jobs in the filtered result
    const filteredJobIds = new Set(allCycles.map(c => c.tracktik_post_id));
    const filteredJobs   = [...filteredJobIds].map(id => jobMap.get(id)).filter(Boolean);
    const openJobs       = filteredJobs.filter(j => j.current_status === "open").length;

    // ── Filter options ────────────────────────────────────────
    const fo     = filterResult.data || [];
    const unique = (key) => [...new Set(fo.map(r => r[key]).filter(Boolean))].sort();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        cycles: shapedCycles,
        pagination: {
          page: pageNum, per_page: limit,
          total, total_pages: Math.ceil(total / limit),
        },
        summary: {
          total_jobs:       filteredJobIds.size,
          open_jobs:        openJobs,
          total_cycles:     total,
          avg_days_to_hire: avgDaysToHire,
        },
        filter_options: {
          regions:           unique("region"),
          cities:            unique("city_of_site_location"),
          hiring_managers:   unique("hiring_manager"),
          officer_types:     unique("officer_type"),
          tracktik_site_ids: unique("tracktik_site_id"),
        },
      }),
    };

  } catch (err) {
    console.error(`[Dashboard Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
