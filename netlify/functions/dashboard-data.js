// netlify/functions/dashboard-data.js
//
// FOUR metrics, all anchored to the SAME date range (Opened From/To):
//
//   1. "Opened in Period" — strict: cycle.opened_at falls in range.
//      Answers: "How many NEW jobs were posted this window?"
//
//   2. "Active During Period" — only jobs STILL OPEN today (is_open
//      = true) that were already open on or before the end of the
//      filter window. This deliberately EXCLUDES jobs that have
//      since closed — even if they overlapped the period — to avoid
//      confusion (a closed job belongs to "Opened in Period" /
//      "Closed (to date)" instead, not here).
//      Answers: "How many jobs are STILL open from this window?"
//
//   3. "Closed (to date)" — of the STRICT "Opened in Period" set, how
//      many have since closed — even if the close date is outside
//      the window. (Example: opened Jun 18 inside a Jun13-19 filter,
//      closed Jun 25 outside it — still counts as closed.)
//
//   4. "Avg Days to Hire" — based on the closed cycles counted in #3.

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  if (event.httpMethod !== "GET")
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };

  const q = event.queryStringParameters || {};
  const {
    tracktik_post_id, tracktik_site_id, status,
    region, city, hiring_manager, officer_type,
    date_from, date_to,
    page = "1", per_page = "50",
  } = q;

  const pageNum = Math.max(1, parseInt(page));
  const limit   = Math.min(100, Math.max(1, parseInt(per_page)));
  const hasPeriod = !!(date_from || date_to);
  const fromIso = date_from ? date_from + "T00:00:00.000Z" : null;
  const toIso   = date_to   ? date_to   + "T23:59:59.999Z" : null;

  try {
    // ── Query 1: jobs (apply job-level filters) ────────────────
    let jobQuery = supabase
      .from("job_requisitions")
      .select("tracktik_post_id, site_name_position_shift, region, city_of_site_location, hiring_manager, officer_type, current_status, total_cycles, tracktik_site_id, ghl_id, advertised_pay_rate, first_seen_at");

    if (status)           jobQuery = jobQuery.eq("current_status", status.toLowerCase());
    if (region)           jobQuery = jobQuery.ilike("region", `%${region}%`);
    if (city)             jobQuery = jobQuery.ilike("city_of_site_location", `%${city}%`);
    if (hiring_manager)   jobQuery = jobQuery.ilike("hiring_manager", `%${hiring_manager}%`);
    if (officer_type)     jobQuery = jobQuery.ilike("officer_type", `%${officer_type}%`);
    if (tracktik_site_id) jobQuery = jobQuery.ilike("tracktik_site_id", `%${tracktik_site_id}%`);

    // ── Query 2: ALL cycles for matched jobs (filtered in JS so we
    //     can compute multiple metrics from a single fetch) ──────
    let cycleQuery = supabase
      .from("job_cycles")
      .select("id, tracktik_post_id, cycle_number, opened_at, closed_at, days_to_hire, pct_time_to_hire, is_open")
      .order("opened_at", { ascending: false });

    if (tracktik_post_id) cycleQuery = cycleQuery.ilike("tracktik_post_id", `%${tracktik_post_id.trim()}%`);

    // ── Query 3: filter options ─────────────────────────────────
    const filterQuery = supabase
      .from("job_requisitions")
      .select("region, city_of_site_location, hiring_manager, officer_type, tracktik_site_id");

    const [jobResult, cycleResult, filterResult] = await Promise.all([jobQuery, cycleQuery, filterQuery]);

    if (jobResult.error)   throw new Error(jobResult.error.message);
    if (cycleResult.error) throw new Error(cycleResult.error.message);

    const jobMap = new Map((jobResult.data || []).map(j => [j.tracktik_post_id, j]));
    const allCycles = (cycleResult.data || []).filter(c => jobMap.has(c.tracktik_post_id));

    // ── Metric 1: "Opened in Period" — strict, cycle.opened_at in range ──
    const strictCycles = hasPeriod
      ? allCycles.filter(c => {
          const openedAt = new Date(c.opened_at);
          if (fromIso && openedAt < new Date(fromIso)) return false;
          if (toIso   && openedAt > new Date(toIso))   return false;
          return true;
        })
      : allCycles;

    const openedInPeriod = new Set(strictCycles.map(c => c.tracktik_post_id)).size;

    // ── Metric 3: "Closed (to date)" — of the strict set, has closed_at at all ──
    const closedCycles = strictCycles.filter(c => c.closed_at !== null);
    const closedCount  = new Set(closedCycles.map(c => c.tracktik_post_id)).size;

    const filledDays = closedCycles.filter(c => c.days_to_hire !== null).map(c => parseFloat(c.days_to_hire));
    const avgDays = filledDays.length > 0
      ? parseFloat((filledDays.reduce((a,b)=>a+b,0)/filledDays.length).toFixed(1))
      : null;

    // ── Metric 2: "Active During Period" — STILL OPEN today ──────
    // Only jobs that are currently open (is_open = true) AND were
    // already open on or before the end of the filter window.
    // This deliberately EXCLUDES jobs that have since closed, even
    // if they overlapped the period — those belong to "Opened in
    // Period" / "Closed (to date)" instead, to avoid confusion.
    const activeCycles = hasPeriod
      ? allCycles.filter(c => {
          if (!c.is_open) return false; // must still be open today
          const openedAt = new Date(c.opened_at);
          if (toIso && openedAt > new Date(toIso)) return false; // opened after window ends
          return true;
        })
      : allCycles.filter(c => c.is_open);

    const activeInPeriod = new Set(activeCycles.map(c => c.tracktik_post_id)).size;

    // ── Table: show the UNION of strict + active cycles ──────────
    // (active is a superset of strict in almost all cases, but using
    // a Map keyed by cycle id avoids any duplicate rows)
    const combinedMap = new Map();
    for (const c of activeCycles) combinedMap.set(c.id, c);
    for (const c of strictCycles) combinedMap.set(c.id, c);
    const combinedCycles = [...combinedMap.values()].sort(
      (a, b) => new Date(b.opened_at) - new Date(a.opened_at)
    );

    const total       = combinedCycles.length;
    const pagedCycles = combinedCycles.slice((pageNum - 1) * limit, (pageNum - 1) * limit + limit);

    const shapedCycles = pagedCycles.map(c => ({
      ...c,
      is_open: !!c.is_open,
      job_requisitions: jobMap.get(c.tracktik_post_id) || {},
    }));

    // ── Filter options ────────────────────────────────────────────
    const fo     = filterResult.data || [];
    const unique = (key) => [...new Set(fo.map(r => r[key]).filter(Boolean))].sort();

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        cycles: shapedCycles,
        pagination: { page: pageNum, per_page: limit, total, total_pages: Math.ceil(total / limit) },
        summary: {
          total_jobs:         openedInPeriod,
          opened_in_period:   openedInPeriod,
          active_in_period:   activeInPeriod,
          closed_in_period:   closedCount,
          avg_days_to_hire:   avgDays,
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
    console.error("[Dashboard Error]", err.message);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: err.message }) };
  }
};
