// app.js — Job Requisition Dashboard

// ── Config ────────────────────────────────────────────────
const API_BASE = "/api";

// ── State ─────────────────────────────────────────────────
let currentPage = 1;
const PER_PAGE  = 50;

// ── DOM refs ──────────────────────────────────────────────
const tableBody    = document.getElementById("table-body");
const tableLoading = document.getElementById("table-loading");
const tableEmpty   = document.getElementById("table-empty");
const mainTable    = document.getElementById("main-table");
const pagination   = document.getElementById("pagination");
const resultsCount = document.getElementById("results-count");

const statTotalJobs    = document.getElementById("stat-total-jobs");
const statAvgDays      = document.getElementById("stat-avg-days");

const modalOverlay  = document.getElementById("modal-overlay");
const modalClose    = document.getElementById("modal-close");
const modalContent  = document.getElementById("modal-content");

// ── Filters ───────────────────────────────────────────────
function getFilters() {
  // flatpickr stores YYYY-MM-DD in the original input, MM/DD/YYYY in the altInput
  // Reading .value from the original input always gives YYYY-MM-DD
  const dateFromEl = document.getElementById("f-date-from");
  const dateToEl   = document.getElementById("f-date-to");
  const dateFrom   = dateFromEl._flatpickr ? dateFromEl.value : dateFromEl.value;
  const dateTo     = dateToEl._flatpickr   ? dateToEl.value   : dateToEl.value;

  return {
    tracktik_post_id: document.getElementById("f-tracktik").value.trim(),
    tracktik_site_id: document.getElementById("f-site-id").value.trim(),
    status:           document.getElementById("f-status").value,
    date_from:        dateFrom,
    date_to:          dateTo,
    region:           document.getElementById("f-region").value,
    city:             document.getElementById("f-city").value,
    hiring_manager:   document.getElementById("f-manager").value,
    officer_type:     document.getElementById("f-officer").value,
  };
}

function buildQueryString(extra = {}) {
  const params = new URLSearchParams();
  const filters = { ...getFilters(), page: currentPage, per_page: PER_PAGE, ...extra };
  Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
  return params.toString();
}

// ── Fetch data ────────────────────────────────────────────
async function loadDashboard() {
  showLoading(true);

  try {
    const qs = buildQueryString();
    const res = await fetch(`${API_BASE}/dashboard-data?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    // Summary stats
    statTotalJobs.textContent   = (data.summary?.total_jobs ?? "—").toLocaleString();
    statAvgDays.textContent     = data.summary?.avg_days_to_hire != null
      ? data.summary.avg_days_to_hire + "d"
      : "—";

    // "Closed in Period" — count of filled cycles in the full filtered result
    // Use summary from API (all pages, not just current page)
    const closedInPeriod = data.summary?.closed_in_period ?? 0;
    document.getElementById("stat-closed-period").textContent = closedInPeriod.toLocaleString();

    // Populate filter dropdowns
    populateSelect("f-region",  data.filter_options?.regions);
    populateSelect("f-city",    data.filter_options?.cities);
    populateSelect("f-manager", data.filter_options?.hiring_managers);
    populateSelect("f-officer", data.filter_options?.officer_types);

    // Table
    renderTable(data.cycles || []);
    renderPagination(data.pagination);

    const total = data.pagination?.total || 0;
    resultsCount.textContent = total
      ? `${total.toLocaleString()} record${total !== 1 ? "s" : ""}`
      : "";

  } catch (err) {
    console.error("Load error:", err);
    showLoading(false);
    showEmpty(true);
  }
}

// ── Render table ─────────────────────────────────────────
function renderTable(cycles) {
  showLoading(false);

  if (!cycles.length) {
    showEmpty(true);
    mainTable.classList.add("hidden");
    return;
  }

  showEmpty(false);
  mainTable.classList.remove("hidden");
  tableBody.innerHTML = "";

  cycles.forEach(cycle => {
    const job = cycle.job_requisitions || {};
    const tr = document.createElement("tr");

    const openedFmt  = cycle.opened_at  ? fmtDate(cycle.opened_at)  : "—";
    const closedFmt  = cycle.closed_at  ? fmtDate(cycle.closed_at)  : "—";
    const daysFmt    = cycle.days_to_hire != null ? Number(cycle.days_to_hire).toFixed(1) + "d" : "—";
    const pct        = cycle.pct_time_to_hire != null ? Number(cycle.pct_time_to_hire).toFixed(1) : null;
    const status     = job.current_status || "created";
    const cycleIsOpen = cycle.is_open;

    tr.innerHTML = `
      <td><span class="cell-id">${esc(cycle.tracktik_post_id)}</span></td>
      <td><span class="cell-site" title="${esc(job.site_name_position_shift || "")}">${esc(job.site_name_position_shift || "—")}</span></td>
      <td>${esc(job.region || "—")}</td>
      <td>${esc(fmtManager(job.hiring_manager) || "—")}</td>
      <td class="cell-cycle">${cycle.cycle_number}</td>
      <td>${openedFmt}</td>
      <td>${cycleIsOpen ? '<span style="color:var(--status-open);font-size:.75rem">● Open</span>' : closedFmt}</td>
      <td class="cell-days">${daysFmt}</td>
      <td>${statusBadge(status)}</td>
      <td><button class="btn--detail" onclick="openDetail('${esc(cycle.tracktik_post_id)}')">Detail</button></td>
    `;
    tableBody.appendChild(tr);
  });
}

// ── Pagination ────────────────────────────────────────────
function renderPagination(pg) {
  if (!pg || pg.total_pages <= 1) { pagination.innerHTML = ""; return; }

  const { page, total_pages } = pg;
  let html = "";

  html += `<button class="page-btn" ${page <= 1 ? "disabled" : ""} onclick="goPage(${page - 1})">← Prev</button>`;

  const start = Math.max(1, page - 2);
  const end   = Math.min(total_pages, page + 2);

  if (start > 1) {
    html += `<button class="page-btn" onclick="goPage(1)">1</button>`;
    if (start > 2) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
  }

  for (let i = start; i <= end; i++) {
    html += `<button class="page-btn ${i === page ? "active" : ""}" onclick="goPage(${i})">${i}</button>`;
  }

  if (end < total_pages) {
    if (end < total_pages - 1) html += `<span style="color:var(--text-muted);padding:0 4px">…</span>`;
    html += `<button class="page-btn" onclick="goPage(${total_pages})">${total_pages}</button>`;
  }

  html += `<button class="page-btn" ${page >= total_pages ? "disabled" : ""} onclick="goPage(${page + 1})">Next →</button>`;

  pagination.innerHTML = html;
}

function goPage(p) {
  currentPage = p;
  loadDashboard();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ── Detail Modal ──────────────────────────────────────────
async function openDetail(tracktikId) {
  modalOverlay.classList.remove("hidden");
  modalContent.innerHTML = `<div style="display:flex;justify-content:center;padding:40px"><div class="spinner"></div></div>`;

  try {
    const res = await fetch(`${API_BASE}/job-detail?tracktik_post_id=${encodeURIComponent(tracktikId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { job, cycles, history } = await res.json();

    modalContent.innerHTML = buildDetailHTML(job, cycles, history);
  } catch (err) {
    modalContent.innerHTML = `<p style="color:var(--accent-red);padding:20px">Failed to load detail: ${err.message}</p>`;
  }
}

function buildDetailHTML(job, cycles, history) {
  // ── Section helper ───────────────────────────────────────
  function row(label, val, mono = false) {
    const display = val && val !== "null" ? esc(val) : '<span style="color:var(--text-muted)">—</span>';
    return `
      <div class="detail-item">
        <div class="detail-item-label">${label}</div>
        <div class="detail-item-value ${mono ? "mono" : ""}">${display}</div>
      </div>`;
  }

  // ── Identity ─────────────────────────────────────────────
  const identityFields = `
    ${row("TrackTik Post ID",  job.tracktik_post_id, true)}
    ${row("TrackTik Site ID",  job.tracktik_site_id, true)}
    ${row("GHL ID",            job.ghl_id,           true)}
    ${row("Current Status",    fmtEnum(job.current_status))}
    ${row("Total Cycles",      String(job.total_cycles ?? 0))}
    ${row("First Seen",        job.first_seen_at ? fmtDate(job.first_seen_at) : null)}
  `;

  // ── Location ─────────────────────────────────────────────
  const locationFields = `
    ${row("Site / Position",   job.site_name_position_shift)}
    ${row("Region",            fmtEnum(job.region))}
    ${row("City",              fmtEnum(job.city_of_site_location))}
    ${row("State",             (job.state_of_site_location || "").toUpperCase())}
    ${row("Zip Code",          job.zip_code_of_site)}
    ${row("Serviceable Zip",   job.serviceable_zip_code)}
    ${row("Tier 1 Zip Codes",  job.tier1_zip_codes)}
    ${row("Tier 2 Zip Codes",  job.tier2_zip_codes)}
    ${row("Tier 3 Zip Codes",  job.tier3_zip_codes)}
  `;

  // ── Position ─────────────────────────────────────────────
  const positionFields = `
    ${row("Officer Type",       fmtEnum(job.officer_type))}
    ${row("Employment Status",  fmtEnum(job.employment_status))}
    ${row("Industry",           fmtEnum(job.industry))}
    ${row("Position Status",    fmtEnum(job.position_status))}
    ${row("Schedule",           job.schedule)}
    ${row("Pay Rate",           job.advertised_pay_rate)}
    ${row("Position Start Date",job.position_start_date)}
    ${row("Applicant Radius",   job.applicant_radius ? job.applicant_radius + " miles" : null)}
    ${row("Applicant Stack Status", fmtEnum(job.applicant_stack_status))}
  `;

  // ── Hiring ───────────────────────────────────────────────
  const hiringFields = `
    ${row("Hiring Manager",     fmtManager(job.hiring_manager))}
    ${row("HR Approval Status", fmtEnum(job.hr_approval_status))}
    ${row("Interview Type",     fmtEnum(job.interview_type))}
    ${row("Interview Calendar", job.interview_calendar)}
    ${row("In-Person Interview Address", job.in_person_interview_address)}
  `;

  // ── Screening ────────────────────────────────────────────
  const screeningFields = `
    ${row("Disqualifying Questions",         job.disqualifying_questions)}
    ${row("Position Specific Requirements",  job.position_specific_requirements)}
    ${row("Preferred Screening Questions",   job.preferred_screening_questions)}
    ${row("Other Preferences",               job.other_preferences)}
  `;

  // ── Job Duties (full width) ──────────────────────────────
  const dutiesBlock = (job.job_duties && job.job_duties !== "null") ? `
    <div class="modal-section">
      <div class="modal-section-title">Job Duties</div>
      <div class="duties-block">${esc(job.job_duties)}</div>
    </div>` : "";

  // ── Cycles ───────────────────────────────────────────────
  const cycleRows = cycles.map(c => `
    <div class="cycle-row">
      <div>
        <div class="cycle-row-label">Cycle</div>
        <div class="cycle-row-val">#${c.cycle_number}</div>
      </div>
      <div>
        <div class="cycle-row-label">Opened</div>
        <div class="cycle-row-val">${c.opened_at ? fmtDate(c.opened_at) : "—"}</div>
      </div>
      <div>
        <div class="cycle-row-label">Closed</div>
        <div class="cycle-row-val">${c.closed_at ? fmtDate(c.closed_at) : c.is_open ? "Still Open" : "—"}</div>
      </div>
      <div>
        <div class="cycle-row-label">Days to Hire</div>
        <div class="cycle-row-val">${c.days_to_hire != null ? Number(c.days_to_hire).toFixed(1) + "d" : "—"}</div>
      </div>
      <div>
        <div class="cycle-row-label">% Time to Hire</div>
        <div class="cycle-row-val">${c.pct_time_to_hire != null ? Number(c.pct_time_to_hire).toFixed(1) + "%" : "—"}</div>
      </div>
      <div>${statusBadge(c.is_open ? "open" : "closed")}</div>
    </div>
  `).join("") || "<p style='color:var(--text-muted);font-size:.85rem'>No cycles recorded.</p>";

  // ── History ──────────────────────────────────────────────
  const historyItems = history.map(h => `
    <div class="history-item">
      <div class="history-dot history-dot--${h.status}"></div>
      <div class="history-info">
        <div class="history-status" style="color:${statusColor(h.status)}">${h.status}${h.cycle_number ? ` — Cycle #${h.cycle_number}` : ""}</div>
        <div class="history-time">${fmtDateFull(h.recorded_at)}</div>
      </div>
    </div>
  `).join("") || "<p style='color:var(--text-muted);font-size:.85rem'>No history recorded.</p>";

  return `
    <div class="modal-title">${esc(job.site_name_position_shift || job.tracktik_post_id)}</div>
    <div class="modal-subtitle">${esc(job.tracktik_post_id)} &nbsp;·&nbsp; ${statusBadge(job.current_status)}</div>

    <div class="modal-section">
      <div class="modal-section-title">Identity</div>
      <div class="detail-grid">${identityFields}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Location</div>
      <div class="detail-grid">${locationFields}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Position Details</div>
      <div class="detail-grid">${positionFields}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Hiring & Interview</div>
      <div class="detail-grid">${hiringFields}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Screening & Requirements</div>
      <div class="detail-grid">${screeningFields}</div>
    </div>

    ${dutiesBlock}

    <div class="modal-section">
      <div class="modal-section-title">Hire Cycles (${cycles.length})</div>
      <div class="cycle-list">${cycleRows}</div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">Status History</div>
      <div class="history-list">${historyItems}</div>
    </div>
  `;
}

// ── Helpers ───────────────────────────────────────────────
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric",
    timeZone: "UTC"
  });
}

function fmtDateFull(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "2-digit", day: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "UTC"
  });
}

function fmtEnum(val) {
  if (!val) return "";
  return val.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

function fmtManager(val) {
  if (!val) return "";
  return val.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

function statusBadge(status) {
  const s = (status || "created").toLowerCase();
  return `<span class="badge badge--${s}">${s}</span>`;
}

function statusColor(status) {
  const map = { open: "#2E7D32", closed: "#C62828", created: "#B8860B" };
  return map[status] || "#555555";
}

function pctBar(pct) {
  const width = Math.min(100, Math.max(0, pct));
  return `
    <div class="pct-bar">
      <div class="pct-track"><div class="pct-fill" style="width:${width}%"></div></div>
      <span class="pct-label">${Number(pct).toFixed(1)}%</span>
    </div>`;
}

function populateSelect(id, values) {
  if (!values || !values.length) return;
  const sel = document.getElementById(id);
  const current = sel.value;
  const existing = new Set(Array.from(sel.options).map(o => o.value));

  values.forEach(v => {
    if (!v || existing.has(v)) return;
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = fmtEnum(v);
    sel.appendChild(opt);
  });

  if (current) sel.value = current;
}

function showLoading(on) {
  tableLoading.classList.toggle("hidden", !on);
  if (on) mainTable.classList.add("hidden");
}
function showEmpty(on) {
  tableEmpty.classList.toggle("hidden", !on);
}

// ── Events ────────────────────────────────────────────────
document.getElementById("btn-apply").addEventListener("click", () => {
  currentPage = 1;
  loadDashboard();
});

document.getElementById("btn-reset").addEventListener("click", () => {
  ["f-tracktik","f-site-id","f-status","f-region","f-city","f-manager","f-officer"]
    .forEach(id => { document.getElementById(id).value = ""; });
  // Clear flatpickr date pickers
  if (document.getElementById("f-date-from")._flatpickr)
    document.getElementById("f-date-from")._flatpickr.clear();
  if (document.getElementById("f-date-to")._flatpickr)
    document.getElementById("f-date-to")._flatpickr.clear();
  currentPage = 1;
  loadDashboard();
});

// Enter key on text filters
document.getElementById("f-tracktik").addEventListener("keydown", e => {
  if (e.key === "Enter") { currentPage = 1; loadDashboard(); }
});
document.getElementById("f-site-id").addEventListener("keydown", e => {
  if (e.key === "Enter") { currentPage = 1; loadDashboard(); }
});

// Modal close
modalClose.addEventListener("click", () => modalOverlay.classList.add("hidden"));
modalOverlay.addEventListener("click", e => {
  if (e.target === modalOverlay) modalOverlay.classList.add("hidden");
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") modalOverlay.classList.add("hidden");
});

// ── Init ──────────────────────────────────────────────────
loadDashboard();
