// netlify/functions/undo-import.js
//
// GET  -> returns info about the most recent un-reverted import batch
// POST -> reverts that batch, restoring the database to its pre-import state
//
// For jobs that DID NOT exist before the import: fully deleted
// (cascade removes their cycles + history too).
//
// For jobs that DID exist before the import: their job_requisitions row,
// job_cycles, and job_status_history are restored exactly to the
// snapshot taken right before the import ran.

const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

exports.handler = async (event) => {
  try {
    // ── GET: return info about the latest undoable batch ────────
    if (event.httpMethod === "GET") {
      const { data: batch, error } = await supabase
        .from("import_batches")
        .select("id, filename, imported_at, total_jobs, total_cycles, status")
        .eq("status", "completed")
        .order("imported_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (error) throw new Error(error.message);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batch: batch || null }),
      };
    }

    // ── POST: revert the latest batch ────────────────────────────
    if (event.httpMethod === "POST") {
      const { data: batch, error: fetchErr } = await supabase
        .from("import_batches")
        .select("*")
        .eq("status", "completed")
        .order("imported_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (fetchErr) throw new Error(fetchErr.message);
      if (!batch) {
        return {
          statusCode: 404,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ error: "No import batch available to undo" }),
        };
      }

      const snapshot = batch.snapshot;
      const { post_ids, new_post_ids, jobs, cycles, history } = snapshot;

      // ── 1. Delete brand-new jobs entirely (cascades to cycles/history) ─
      if (new_post_ids.length) {
        const { error } = await supabase
          .from("job_requisitions")
          .delete()
          .in("tracktik_post_id", new_post_ids);
        if (error) throw new Error(`Delete new jobs: ${error.message}`);
      }

      // ── 2. For previously-existing jobs: wipe current cycles/history ───
      const existingPostIds = post_ids.filter(id => !new_post_ids.includes(id));

      if (existingPostIds.length) {
        const { error: delCycErr } = await supabase
          .from("job_cycles")
          .delete()
          .in("tracktik_post_id", existingPostIds);
        if (delCycErr) throw new Error(`Delete cycles: ${delCycErr.message}`);

        const { error: delHistErr } = await supabase
          .from("job_status_history")
          .delete()
          .in("tracktik_post_id", existingPostIds);
        if (delHistErr) throw new Error(`Delete history: ${delHistErr.message}`);

        // Restore job_requisitions rows to their pre-import state
        const jobsToRestore = jobs.filter(j => existingPostIds.includes(j.tracktik_post_id));
        if (jobsToRestore.length) {
          const { error: restoreErr } = await supabase
            .from("job_requisitions")
            .upsert(jobsToRestore, { onConflict: "tracktik_post_id" });
          if (restoreErr) throw new Error(`Restore jobs: ${restoreErr.message}`);
        }

        // Restore cycles
        if (cycles.length) {
          for (let i = 0; i < cycles.length; i += 500) {
            const chunk = cycles.slice(i, i + 500);
            const { error } = await supabase.from("job_cycles").insert(chunk);
            if (error) throw new Error(`Restore cycles: ${error.message}`);
          }
        }

        // Restore history
        if (history.length) {
          for (let i = 0; i < history.length; i += 500) {
            const chunk = history.slice(i, i + 500);
            const { error } = await supabase.from("job_status_history").insert(chunk);
            if (error) throw new Error(`Restore history: ${error.message}`);
          }
        }
      }

      // ── 3. Mark batch as reverted ────────────────────────────────
      const { error: updateErr } = await supabase
        .from("import_batches")
        .update({ status: "reverted" })
        .eq("id", batch.id);
      if (updateErr) throw new Error(`Mark reverted: ${updateErr.message}`);

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          success: true,
          reverted_batch_id: batch.id,
          filename: batch.filename,
          deleted_new_jobs: new_post_ids.length,
          restored_jobs: existingPostIds.length,
        }),
      };
    }

    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (err) {
    console.error(`[Undo Import Error] ${err.message}`);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
