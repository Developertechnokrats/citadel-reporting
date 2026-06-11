// netlify/functions/dashboard-data.js
// Returns filtered dashboard data for the frontend.
//
// All filters are applied at the DATABASE level (using !inner joins for
// nested job_requisitions fields), so both the table results AND the
// summary stats (Total Jobs, Currently Open, Total Cycles, Avg Days to
// Hire) reflect whatever filters are active. With no filters applied,
// the stats reflect the entire dataset.

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
    tracktik_post_id,
    tracktik_site_id,
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

  // ── Shared filter applier ──────────────────────────────────
  // Applies all active filters to a job_cycles query that has joined
  // job_requisitions via "!inner" (required for nested filtering).
  function applyFilters(query) {
    if (tracktik_post_id) {
      query = query.ilike("tracktik_post_id", `%${tracktik_post_id.trim()}%`);
    }
    if (date_from) {
      query = query.gte("opened_at", new Date(date_from).toISOString());
    }
    if (date_to) {
      const end = new Date(date_to);
      end.setHours(23, 59, 59, 999);
      query = query.lte("opened_at", end.toISOString());
    }
    if (status) {
      query = query.eq("job_requisitions.current_status", status.toLowerCase());
    }
    if (region) {
      query = query.ilike("job_requisitions.region", `%${region}%`);
    }
    if (city) {
      query = query.ilike("job_requisitions.city_of_site_location", `%${city}%`);
    }
    if (hiring_manager) {
      query = query.ilike("job_requisitions.hiring_manager", `%${hiring_manager}%`);
    }
    if (officer_type) {
      query = query.ilike("job_requisitions.officer_type", `%${officer_type}%`);
    }
    if (tracktik_site_id) {
      query = query.ilike("job_requisitions.tracktik_site_id", `%${tracktik_site_id}%`);
    }
    return query;
  }

  try {
    // ── Query 1: Job cycles with job details (paginated table data) ──
    let cycleQuery = supabase
      .from("job_cycles")
      .select(`
        *,
        job_requisitions!inner (
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
          zip_code_of_site,
          interview_calendar,
          interview_type,
          applicant_radius,
          applicant_stack_status,
          disqualifying_questions,
          position_specific_requirements,
          preferred_screening_questions,
          serviceable_zip_code,
          tier1_zip_codes,
          tier2_zip_codes,
          tier3_zip_codes,
          in_person_interview_address,
          job_duties,
          other_preferences,
          first_seen_at
        )
      `, { count: "exact" })
      .order("opened_at", { ascending: false })
      .range(offset, offset + limit - 1);

    cycleQuery = applyFilters(cycleQuery);

    const { data: cycles, error: cycleErr, count: totalCycles } = await cycleQuery;
    if (cycleErr) throw new Error(`Cycles query: ${cycleErr.message}`);

    // ── Query 2: Summary stats — SAME filters, no pagination ─────────
    // Avg Days to Hire: only cycles that are closed with a real
    // days_to_hire value (i.e. "filled" cycles) count toward the average.
    let statsQuery = supabase
      .from("job_cycles")
      .select(`
        days_to_hire,
        job_requisitions!inner ( tracktik_post_id, current_status )
      `);
    statsQuery = applyFilters(statsQuery);

    const { data: statsCycles, error: statsErr } = await statsQuery;
    if (statsErr) throw new Error(`Stats query: ${statsErr.message}`);

    const allFilteredCycles = statsCycles || [];
    const filledCycles = allFilteredCycles.filter(c => c.days_to_hire !== null);
    const avgDaysToHire = filledCycles.length > 0
      ? parseFloat(
          (filledCycles.reduce((s, c) => s + parseFloat(c.days_to_hire || 0), 0) / filledCycles.length).toFixed(1)
        )
      : 0;

    // Distinct jobs represented in the filtered cycle set
    const jobMap = new Map();
    for (const c of allFilteredCycles) {
      const j = c.job_requisitions;
      if (j && !jobMap.has(j.tracktik_post_id)) jobMap.set(j.tracktik_post_id, j);
    }
    const totalJobs = jobMap.size;
    const openJobs = [...jobMap.values()].filter(j => j.current_status === "open").length;

    // ── Query 3: Filter options (distinct values, always global) ─────
    const { data: filterOptions } = await supabase
      .from("job_requisitions")
      .select("region, city_of_site_location, hiring_manager, officer_type, current_status, tracktik_site_id");

    const uniqueRegions   = [...new Set((filterOptions || []).map(r => r.region).filter(Boolean))].sort();
    const uniqueCities    = [...new Set((filterOptions || []).map(r => r.city_of_site_location).filter(Boolean))].sort();
    const uniqueManagers  = [...new Set((filterOptions || []).map(r => r.hiring_manager).filter(Boolean))].sort();
    const uniqueOfficers  = [...new Set((filterOptions || []).map(r => r.officer_type).filter(Boolean))].sort();
    const uniqueSiteIds   = [...new Set((filterOptions || []).map(r => r.tracktik_site_id).filter(Boolean))].sort();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        cycles: cycles || [],
        pagination: {
          page: pageNum,
          per_page: limit,
          total: totalCycles,
          total_pages: Math.ceil((totalCycles || 0) / limit),
        },
        summary: {
          total_jobs: totalJobs,
          open_jobs: openJobs,
          total_cycles: allFilteredCycles.length,
          avg_days_to_hire: avgDaysToHire,
        },
        filter_options: {
          regions:          uniqueRegions,
          cities:           uniqueCities,
          hiring_managers:  uniqueManagers,
          officer_types:    uniqueOfficers,
          tracktik_site_ids: uniqueSiteIds,
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
