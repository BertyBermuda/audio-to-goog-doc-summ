import { getSupabase, BUCKET, authorize, methodGuard } from "../../lib/api";

/**
 * Step 3. Pabbly posts here once the Google Doc exists.
 *
 * Expects { jobId, docUrl } on success or { jobId, error } on failure, plus the
 * callback secret in either an X-Extension-Secret header or a "secret" body field
 * (Pabbly's action steps make body fields much easier to set than headers).
 */
export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!authorize(req, res, { secretEnv: "PABBLY_CALLBACK_SECRET" })) return;

  const supabase = getSupabase();

  const { jobId, docUrl, error } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: "Missing jobId" });

  try {
    const { data: job, error: lookupError } = await supabase
      .from("jobs")
      .select("id, status, storage_path")
      .eq("id", jobId)
      .single();

    if (lookupError || !job) return res.status(404).json({ error: "Unknown jobId" });

    // A workflow that retries shouldn't overwrite a result that already landed.
    if (job.status === "done") return res.status(200).json({ ok: true, note: "already done" });

    const update = docUrl
      ? { status: "done", doc_url: String(docUrl), error: null }
      : { status: "error", error: String(error ?? "Pabbly reported no docUrl").slice(0, 1000) };

    const { error: updateError } = await supabase.from("jobs").update(update).eq("id", jobId);
    if (updateError) throw updateError;

    // The audio has served its purpose; don't leave recordings sitting in storage.
    await supabase.storage.from(BUCKET).remove([job.storage_path]).then(null, () => {});

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[callback]", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
