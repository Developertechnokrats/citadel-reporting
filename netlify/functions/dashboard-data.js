// netlify/functions/dashboard-data.js
//
// FOUR metrics, all anchored to the SAME date range (Opened From/To):
//
//   1. "Opened in Period" — strict: cycle.opened_at falls in range.
//      Answers: "How many NEW jobs were posted this window?"
//
//   2. "Total Job Req During Period" — counts TOUCH-EVENTS (cycle
//      rows), NOT distinct tracktik_post_id — a deliberate departure
//      from every other card on this dashboard. A cycle counts if:
//        (is_open = true AND opened_at <= period_to)
//        OR (opened_at falls within the period)
//        OR (closed_at falls within the period)
//      A job that closed and reopened within the same window (filled
//      once, then reposted) has two real cycle rows, and both count,
//      since each represents genuine hiring activity.
//      Answers: "How many hiring events touched this window?"
//
//   3. "Closed in Period" — distinct jobs where closed_at falls
//      within the date range, REGARDLESS of when they opened. This
//      is fully independent of "Opened in Period" — a job opened
//      weeks ago that closes during this window still counts here.
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
      .select("tracktik_post_id, site_name_position_shift, region, city_of_site_location, hiring_manager, officer_type, current_status, total_cycles, tracktik_site_id, ghl_id, advertised_pay_rate, first_seen_at, hiring_needs");

    // NOTE: status is intentionally NOT filtered here. `current_status`
    // reflects only a job's LATEST state, which drops reopened jobs out
    // of the "Closed" view. Status is applied cycle-aware below instead.
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
    const rawCycles = (cycleResult.data || []).filter(c => jobMap.has(c.tracktik_post_id));

    // ── Status filter (cycle-aware) ──────────────────────────────
    // Match on a job's FULL cycle history, not its latest status, so a
    // job that was closed then reopened shows up under BOTH views:
    //   open   → job has at least one still-open cycle (is_open === true)
    //   closed → job has at least one cycle that was ever closed (closed_at != null)
    let allCycles = rawCycles;
    if (status) {
      const s = status.toLowerCase();
      const byJob = new Map();
      for (const c of rawCycles) {
        if (!byJob.has(c.tracktik_post_id)) byJob.set(c.tracktik_post_id, []);
        byJob.get(c.tracktik_post_id).push(c);
      }
      const matchIds = new Set();
      for (const [pid, cyc] of byJob) {
        const ok = s === "open"   ? cyc.some(c => c.is_open === true)
                 : s === "closed" ? cyc.some(c => c.closed_at !== null)
                 : true;
        if (ok) matchIds.add(pid);
      }
      allCycles = rawCycles.filter(c => matchIds.has(c.tracktik_post_id));
    }

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

    // ── Metric 3: "Closed in Period" — closed_at falls in range,
    //     independent of when the job opened ─────────────────────
    const closedCycles = hasPeriod
      ? allCycles.filter(c => {
          if (!c.closed_at) return false;
          const closedAt = new Date(c.closed_at);
          if (fromIso && closedAt < new Date(fromIso)) return false;
          if (toIso   && closedAt > new Date(toIso))   return false;
          return true;
        })
      : allCycles.filter(c => c.closed_at !== null);

    const closedCount = new Set(closedCycles.map(c => c.tracktik_post_id)).size;

    const filledDays = closedCycles.filter(c => c.days_to_hire !== null).map(c => parseFloat(c.days_to_hire));
    const avgDays = filledDays.length > 0
      ? parseFloat((filledDays.reduce((a,b)=>a+b,0)/filledDays.length).toFixed(1))
      : null;

    // ── Metric 2: "Total Job Req During Period" — counts TOUCH-EVENTS
    //     (cycle rows), not distinct tracktik_post_id. A job that closed
    //     and reopened within the window has two real cycle rows, and
    //     both represent genuine hiring activity, so both are counted.
    //     This is a deliberate departure from every other card here.
    const touchedCycles = hasPeriod
      ? allCycles.filter(c => {
          const openedAt = new Date(c.opened_at);
          const closedAt = c.closed_at ? new Date(c.closed_at) : null;

          // Condition A: currently open AND opened on/before window end
          const isActiveAndOpenedBeforeEnd =
            c.is_open === true && openedAt <= new Date(toIso);

          // Condition B: opened DURING the window (regardless of current status)
          const openedDuringWindow =
            openedAt >= new Date(fromIso) && openedAt <= new Date(toIso);

          // Condition C: closed DURING the window
          const closedDuringWindow =
            closedAt && closedAt >= new Date(fromIso) && closedAt <= new Date(toIso);

          return isActiveAndOpenedBeforeEnd || openedDuringWindow || closedDuringWindow;
        })
      : allCycles;

    const totalTouchedInPeriod = touchedCycles.length;

    // ── Metric 5: "Hiring Need in the Period" — SUM of hiring_needs
    //     across the DISTINCT jobs whose cycles touched the window
    //     (same set that feeds Metric 2). hiring_needs lives on
    //     job_requisitions (one value PER JOB, not per cycle), so we
    //     collapse touched cycles to distinct tracktik_post_id first —
    //     this prevents a reopened job (two cycle rows) from counting
    //     its hiring need twice. Missing/null values contribute 0,
    //     matching how avg_days_to_hire ignores nulls.
    const hiringNeedPostIds = new Set(touchedCycles.map(c => c.tracktik_post_id));
    let hiringNeedInPeriod = 0;
    for (const pid of hiringNeedPostIds) {
      const job = jobMap.get(pid);
      const hn = job && job.hiring_needs != null ? parseInt(job.hiring_needs, 10) : 0;
      if (!Number.isNaN(hn)) hiringNeedInPeriod += hn;
    }

    // ── Table: show the UNION of strict (opened) + touched (overlap) + closed-in-period ──
    const combinedMap = new Map();
    for (const c of touchedCycles) combinedMap.set(c.id, c);
    for (const c of strictCycles) combinedMap.set(c.id, c);
    for (const c of closedCycles) combinedMap.set(c.id, c);
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
          total_touched_in_period: totalTouchedInPeriod,
          closed_in_period:   closedCount,
          avg_days_to_hire:   avgDays,
          hiring_need_in_period: hiringNeedInPeriod,
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
