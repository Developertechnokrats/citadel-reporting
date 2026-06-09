// netlify/functions/dashboard-data.js
// Returns filtered dashboard data for the frontend

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

  // ── Parse filters ─────────────────────────────────────────
  const {
    tracktik_post_id,
    status,
    region,
    city,
    hiring_manager,
    officer_type,
    date_from,        // filter by cycle opened_at
    date_to,
    page = "1",
    per_page = "50",
  } = q;

  const pageNum = Math.max(1, parseInt(page));
  const limit   = Math.min(100, Math.max(1, parseInt(per_page)));
  const offset  = (pageNum - 1) * limit;

  try {
    // ── Query 1: Job cycles with job details ──────────────────
    let cycleQuery = supabase
      .from("job_cycles")
      .select(`
        *,
        job_requisitions (
          tracktik_post_id,
          ghl_id,
          site_name_position_shift,
          region,
          city_of_site_location,
          state_of_site_location,
          hiring_manager,
          officer_type,
          employment_status,
          schedule,
          position_start_date,
          current_status,
          total_cycles,
          advertised_pay_rate,
          industry,
          hr_approval_status,
          tracktik_site_id,
          first_seen_at
        )
      `, { count: "exact" })
      .order("opened_at", { ascending: false })
      .range(offset, offset + limit - 1);

    // Apply filters
    if (tracktik_post_id) {
      cycleQuery = cycleQuery.eq("tracktik_post_id", tracktik_post_id.trim());
    }
    if (date_from) {
      cycleQuery = cycleQuery.gte("opened_at", new Date(date_from).toISOString());
    }
    if (date_to) {
      // end of day
      const end = new Date(date_to);
      end.setHours(23, 59, 59, 999);
      cycleQuery = cycleQuery.lte("opened_at", end.toISOString());
    }

    const { data: cycles, error: cycleErr, count: totalCycles } = await cycleQuery;
    if (cycleErr) throw new Error(`Cycles query: ${cycleErr.message}`);

    // Post-filter by job fields (Supabase nested filters)
    let filteredCycles = cycles || [];
    if (status) {
      filteredCycles = filteredCycles.filter(
        c => c.job_requisitions?.current_status === status.toLowerCase()
      );
    }
    if (region) {
      filteredCycles = filteredCycles.filter(
        c => c.job_requisitions?.region?.toLowerCase().includes(region.toLowerCase())
      );
    }
    if (city) {
      filteredCycles = filteredCycles.filter(
        c => c.job_requisitions?.city_of_site_location?.toLowerCase().includes(city.toLowerCase())
      );
    }
    if (hiring_manager) {
      filteredCycles = filteredCycles.filter(
        c => c.job_requisitions?.hiring_manager?.toLowerCase().includes(hiring_manager.toLowerCase())
      );
    }
    if (officer_type) {
      filteredCycles = filteredCycles.filter(
        c => c.job_requisitions?.officer_type?.toLowerCase().includes(officer_type.toLowerCase())
      );
    }

    // ── Query 2: Summary stats ────────────────────────────────
    const { data: statsData } = await supabase
      .from("job_cycles")
      .select("days_to_hire, is_open");

    const allCycles = statsData || [];
    const closedCycles = allCycles.filter(c => c.days_to_hire !== null);
    const avgDaysToHire = closedCycles.length > 0
      ? parseFloat((closedCycles.reduce((s, c) => s + parseFloat(c.days_to_hire || 0), 0) / closedCycles.length).toFixed(1))
      : 0;

    const { count: totalJobs } = await supabase
      .from("job_requisitions")
      .select("*", { count: "exact", head: true });

    const { count: openJobs } = await supabase
      .from("job_requisitions")
      .select("*", { count: "exact", head: true })
      .eq("current_status", "open");

    // ── Query 3: Filter options (distinct values) ─────────────
    const { data: filterOptions } = await supabase
      .from("job_requisitions")
      .select("region, city_of_site_location, hiring_manager, officer_type, current_status");

    const uniqueRegions   = [...new Set((filterOptions || []).map(r => r.region).filter(Boolean))].sort();
    const uniqueCities    = [...new Set((filterOptions || []).map(r => r.city_of_site_location).filter(Boolean))].sort();
    const uniqueManagers  = [...new Set((filterOptions || []).map(r => r.hiring_manager).filter(Boolean))].sort();
    const uniqueOfficers  = [...new Set((filterOptions || []).map(r => r.officer_type).filter(Boolean))].sort();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        cycles: filteredCycles,
        pagination: {
          page: pageNum,
          per_page: limit,
          total: totalCycles,
          total_pages: Math.ceil((totalCycles || 0) / limit),
        },
        summary: {
          total_jobs: totalJobs || 0,
          open_jobs: openJobs || 0,
          total_cycles: allCycles.length,
          avg_days_to_hire: avgDaysToHire,
        },
        filter_options: {
          regions:          uniqueRegions,
          cities:           uniqueCities,
          hiring_managers:  uniqueManagers,
          officer_types:    uniqueOfficers,
        },
      }),
    };

  } catch (err) {
    console.error(`[Dashboard API Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
