# Job Requisition Dashboard — Full Deployment Guide

## What You're Deploying

```
GHL Workflow  →  Netlify Webhook  →  Supabase Database  →  Dashboard UI
```

- **Webhook URL:** `https://your-site.netlify.app/webhook/job-requisition`
- **Dashboard:** `https://your-site.netlify.app`
- **Database:** Supabase (Postgres)

---

## STEP 1 — Create Your Supabase Project

1. Go to **https://supabase.com** and sign in (or create a free account)
2. Click **New project**
3. Fill in:
   - **Name:** `job-req-dashboard` (or anything you like)
   - **Database Password:** choose a strong password and save it
   - **Region:** pick the closest to you
4. Wait ~2 minutes for the project to spin up

### Run the Database Schema

1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Open the file `supabase/schema.sql` from this project
4. Paste the entire contents into the SQL editor
5. Click **Run** (green button)
6. You should see: `Success. No rows returned`

### Get Your Supabase Keys

1. Go to **Settings** (gear icon) → **API**
2. Copy two values:
   - **Project URL** → looks like `https://abcdefgh.supabase.co`
   - **service_role** key → long string starting with `eyJ...` ⚠️ Keep this SECRET

---

## STEP 2 — Push Code to GitHub

1. Create a new **private** repository on GitHub
2. In your terminal, inside the project folder:

```bash
git init
git add .
git commit -m "Initial deployment"
git remote add origin https://github.com/YOUR_USERNAME/job-req-dashboard.git
git push -u origin main
```

---

## STEP 3 — Deploy to Netlify

1. Go to **https://netlify.com** and sign in
2. Click **Add new site** → **Import an existing project**
3. Choose **GitHub** and authorize Netlify
4. Select your `job-req-dashboard` repository
5. Build settings (should auto-detect from `netlify.toml`):
   - **Base directory:** (leave empty)
   - **Build command:** (leave empty)
   - **Publish directory:** `public`
6. Click **Deploy site**

### Add Environment Variables in Netlify

1. Go to your site → **Site configuration** → **Environment variables**
2. Click **Add a variable** for each:

| Key | Value |
|-----|-------|
| `SUPABASE_URL` | Your Supabase Project URL |
| `SUPABASE_SERVICE_KEY` | Your Supabase service_role key |
| `WEBHOOK_SECRET` | Any random string (e.g. `myjobsdashboard2024!`) |

3. Click **Save**
4. Go to **Deploys** → **Trigger deploy** → **Deploy site** (to reload with new env vars)

### Your URLs

After deploy, you'll have:
- **Dashboard:** `https://your-site.netlify.app`
- **Webhook endpoint:** `https://your-site.netlify.app/webhook/job-requisition`

Copy your webhook URL — you'll need it in Step 4.

---

## STEP 4 — Configure GHL Workflow

### Create the Webhook in GHL

1. In GoHighLevel, go to **Automation** → **Workflows**
2. Create a new workflow (or edit your existing one for Job Requisitions)
3. Add a **Webhook** action
4. Configure:
   - **Method:** `POST`
   - **URL:** `https://your-site.netlify.app/webhook/job-requisition`
   - **Headers:**
     - Key: `Content-Type` → Value: `application/json`
     - Key: `X-Webhook-Secret` → Value: (same secret you set in Netlify)
   - **Body:** Select your Job Requisition custom object fields and map them to JSON

### GHL Workflow Triggers

Set up **two** workflow triggers (or one workflow with conditions):

**Trigger 1 — Job Created:**
- Trigger: Custom Object Created (Job Requisition)
- Action: Send webhook with full JSON

**Trigger 2 — Job Updated:**  
- Trigger: Custom Object Updated (Job Requisition) — specifically when `Operational Job Status` field changes
- Action: Send webhook with full JSON

### JSON Body Template in GHL

Map the fields exactly as they appear in the examples. The webhook expects these exact field names:

```json
{
  "ID": "{{customObject.id}}",
  "TrackTik Post ID": "{{customObject.tracktikPostId}}",
  "TrackTik Site ID": "{{customObject.tracktikSiteId}}",
  "Operational Job Status": "{{customObject.operationalJobStatus}}",
  "Site Name - Position Type - Shift": "{{customObject.siteNamePositionShift}}",
  "Advertised Pay Rate": "{{customObject.advertisedPayRate}}",
  "Region": "{{customObject.region}}",
  "City of the Site Location": "{{customObject.cityOfSiteLocation}}",
  "State of the Site Location": "{{customObject.stateOfSiteLocation}}",
  "Zip Code of Site Location": "{{customObject.zipCodeOfSiteLocation}}",
  "Hiring Manager": "{{customObject.hiringManager}}",
  "Officer Type": "{{customObject.officerType}}",
  "Employment Status": "{{customObject.employmentStatus}}",
  "Industry": "{{customObject.industry}}",
  "Schedule": "{{customObject.schedule}}",
  "HR Approval Status": "{{customObject.hrApprovalStatus}}",
  "Position Start Date/Fill By Date": "{{customObject.positionStartDate}}",
  "Position Status": "{{customObject.positionStatus}}",
  "Interview Type": "{{customObject.interviewType}}",
  "Applicant Radius": "{{customObject.applicantRadius}}",
  "Applicant Stack Status": "{{customObject.applicantStackStatus}}"
}
```

> **Note:** The exact GHL merge tags depend on how your custom object fields are named in your account. Match the field names to what the webhook expects.

---

## STEP 5 — Test the Webhook

### Manual Test (using curl)

Open your terminal and run:

```bash
# Test: Create a new job
curl -X POST https://your-site.netlify.app/webhook/job-requisition \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: myjobsdashboard2024!" \
  -d '{
    "ID": "test001",
    "TrackTik Post ID": "P00017-UAPTA",
    "TrackTik Site ID": "P00017",
    "Operational Job Status": "open",
    "Site Name - Position Type - Shift": "Community Hospital - Unarmed Officer",
    "Region": "western_slopes_region",
    "City of the Site Location": "grand_junction",
    "State of the Site Location": "co",
    "Hiring Manager": "jeff_patton",
    "Officer Type": "unarmed",
    "Advertised Pay Rate": "$18.00",
    "Employment Status": "part_time"
  }'

# Expected response:
# {"success":true,"tracktik_post_id":"P00017-UAPTA","status":"open","cycle_number":1}

# Test: Close the job
curl -X POST https://your-site.netlify.app/webhook/job-requisition \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: myjobsdashboard2024!" \
  -d '{
    "ID": "test001",
    "TrackTik Post ID": "P00017-UAPTA",
    "Operational Job Status": "closed"
  }'

# Expected response:
# {"success":true,"tracktik_post_id":"P00017-UAPTA","status":"closed","cycle_number":1}
```

### Verify in Supabase

1. Go to Supabase → **Table Editor**
2. Check these tables:
   - `job_requisitions` → should have 1 row
   - `job_status_history` → should have 2 rows (open + closed)
   - `job_cycles` → should have 1 row with `days_to_hire` filled in

---

## STEP 6 — Access the Dashboard

Open `https://your-site.netlify.app` in your browser.

### Dashboard Features

| Feature | How to Use |
|---------|-----------|
| **Filter by TrackTik Post ID** | Type exact ID or partial match |
| **Filter by date range** | Set "Opened From" and "Opened To" dates |
| **Filter by status** | Open / Closed / Created |
| **Filter by region, city, manager** | Use the dropdowns |
| **View cycle detail** | Click "Detail" button on any row |
| **See all jobs** | Click "All Jobs" in the top nav |

### Understanding the % Time to Hire

For a job opened and closed multiple times:
- Each cycle's `days_to_hire` = days from Open to Close
- `% Time to Hire` = that cycle's days ÷ total days across ALL cycles × 100
- This tells you which cycle took the most effort to fill

**Example:**
```
Cycle 1: 8 days  → 8/25 = 32%
Cycle 2: 5 days  → 5/25 = 20%  
Cycle 3: 12 days → 12/25 = 48%
Total:   25 days
```

---

## Troubleshooting

### Webhook returns 401
→ Check that `WEBHOOK_SECRET` in Netlify matches the `X-Webhook-Secret` header in GHL

### Webhook returns 500
→ Check Netlify Function logs: Site → Functions → job-requisition → View logs

### Dashboard shows no data
→ Verify `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set correctly in Netlify env vars

### "No open cycle found" warning in logs
→ A "closed" webhook arrived but there was no prior "open" event. Check GHL workflow order.

### Local development
```bash
npm install
cp .env.example .env
# Edit .env with your real values
npx netlify dev
# Dashboard: http://localhost:8888
# Webhook: http://localhost:8888/webhook/job-requisition
```

---

## File Structure

```
job-req-dashboard/
├── netlify/
│   └── functions/
│       ├── job-requisition.js   ← Webhook receiver
│       ├── dashboard-data.js    ← Dashboard API
│       └── job-detail.js        ← Single job detail API
├── public/
│   ├── index.html               ← Main dashboard
│   ├── jobs.html                ← All jobs list
│   ├── styles.css               ← All styles
│   └── app.js                   ← Dashboard JavaScript
├── supabase/
│   └── schema.sql               ← Run this in Supabase SQL Editor
├── .env.example                 ← Copy to .env for local dev
├── netlify.toml                 ← Netlify configuration
└── package.json
```
