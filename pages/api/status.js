import { getSupabase, authorize, methodGuard } from "../../lib/api";

// A job that never gets a callback shouldn't leave the extension polling forever.
const STALE_AFTER_MS = 20 * 60 * 1000;

/** Step 4. The extension polls this until status leaves "processing". */
export default async function handler(req, res) {
  if (!methodGuard(req, res, "GET")) return;
  if (!authorize(req, res)) return;

  const supabase = getSupabase();

  const jobId = req.query.jobId;
  if (!jobId) return res.status(400).json({ error: "Missing jobId" });

  try {
    const { data: job, error } = await supabase
      .from("jobs")
      .select("id, status, doc_url, error, file_name, created_at")
      .eq("id", jobId)
      .single();

    if (error || !job) return res.status(404).json({ error: "Unknown jobId" });

    const age = Date.now() - new Date(job.created_at).getTime();
    if (job.status === "processing" && age > STALE_AFTER_MS) {
      return res.status(200).json({
        jobId: job.id,
        status: "error",
        error: "Timed out waiting for Pabbly to call back"
      });
    }

    return res.status(200).json({
      jobId: job.id,
      status: job.status,
      docUrl: job.doc_url,
      error: job.error,
      fileName: job.file_name
    });
  } catch (err) {
    console.error("[status]", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}
