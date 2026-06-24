// netlify/functions/dashboard-data.js
// Optimised: parallel queries, lightweight field selection for table view

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
  const offset  = (pageNum - 1) * limit;

  function applyFilters(query) {
    if (tracktik_post_id) query = query.ilike("tracktik_post_id", `%${tracktik_post_id.trim()}%`);
    if (date_from)        query = query.gte("opened_at", new Date(date_from).toISOString());
    if (date_to)          { const e = new Date(date_to); e.setHours(23,59,59,999); query = query.lte("opened_at", e.toISOString()); }
    if (status)           query = query.eq("job_requisitions.current_status", status.toLowerCase());
    if (region)           query = query.ilike("job_requisitions.region", `%${region}%`);
    if (city)             query = query.ilike("job_requisitions.city_of_site_location", `%${city}%`);
    if (hiring_manager)   query = query.ilike("job_requisitions.hiring_manager", `%${hiring_manager}%`);
    if (officer_type)     query = query.ilike("job_requisitions.officer_type", `%${officer_type}%`);
    if (tracktik_site_id) query = query.ilike("job_requisitions.tracktik_site_id", `%${tracktik_site_id}%`);
    return query;
  }

  try {
    // Run all 3 queries in parallel for speed
    const [cycleResult, statsResult, filterResult] = await Promise.all([

      // Query 1: paginated cycles — lightweight fields only for table display
      applyFilters(
        supabase.from("job_cycles")
          .select(`
            id, tracktik_post_id, cycle_number,
            opened_at, closed_at, days_to_hire, pct_time_to_hire, is_open,
            job_requisitions!inner (
              tracktik_post_id, site_name_position_shift,
              region, city_of_site_location, hiring_manager,
              officer_type, current_status, total_cycles,
              tracktik_site_id, needs_review
            )
          `, { count: "exact" })
          .order("opened_at", { ascending: false })
          .range(offset, offset + limit - 1)
      ),

      // Query 2: stats — minimal fields
      applyFilters(
        supabase.from("job_cycles")
          .select("days_to_hire, job_requisitions!inner ( tracktik_post_id, current_status )")
      ),

      // Query 3: filter options — always global (no filters applied)
      supabase.from("job_requisitions")
        .select("region, city_of_site_location, hiring_manager, officer_type, current_status, tracktik_site_id"),
    ]);

    if (cycleResult.error)  throw new Error(`Cycles: ${cycleResult.error.message}`);
    if (statsResult.error)  throw new Error(`Stats: ${statsResult.error.message}`);

    const cycles        = cycleResult.data  || [];
    const totalCount    = cycleResult.count || 0;
    const statsCycles   = statsResult.data  || [];
    const filterOptions = filterResult.data || [];

    // Summary stats
    const filledCycles  = statsCycles.filter(c => c.days_to_hire !== null);
    const avgDaysToHire = filledCycles.length > 0
      ? parseFloat((filledCycles.reduce((s,c) => s + parseFloat(c.days_to_hire||0), 0) / filledCycles.length).toFixed(1))
      : 0;

    const jobMap = new Map();
    for (const c of statsCycles) {
      const j = c.job_requisitions;
      if (j && !jobMap.has(j.tracktik_post_id)) jobMap.set(j.tracktik_post_id, j);
    }

    // Filter options
    const unique = (key) => [...new Set(filterOptions.map(r => r[key]).filter(Boolean))].sort();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        cycles,
        pagination: { page: pageNum, per_page: limit, total: totalCount, total_pages: Math.ceil(totalCount / limit) },
        summary: {
          total_jobs:       jobMap.size,
          open_jobs:        [...jobMap.values()].filter(j => j.current_status === "open").length,
          total_cycles:     statsCycles.length,
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
