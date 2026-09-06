import { getSupabase, BUCKET, authorize, methodGuard } from "../../lib/api";

const PABBLY_TIMEOUT_MS = 10_000;
const DOWNLOAD_URL_TTL_SECONDS = 3600;

/**
 * Step 2. The upload has landed in Supabase; hand Pabbly a signed download URL
 * and a callback to report back to, then return immediately.
 *
 * This function does no transcription work, so it finishes in well under any
 * serverless timeout. The long-running work lives in the Pabbly workflow.
 */
export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!authorize(req, res)) return;

  const supabase = getSupabase();

  const { jobId, fileName } = req.body ?? {};
  if (!jobId) return res.status(400).json({ error: "Missing jobId" });

  const webhookUrl = process.env.PABBLY_WEBHOOK_URL;
  const callbackSecret = process.env.PABBLY_CALLBACK_SECRET;
  if (!webhookUrl) return res.status(500).json({ error: "PABBLY_WEBHOOK_URL is not configured" });
  if (!callbackSecret) return res.status(500).json({ error: "PABBLY_CALLBACK_SECRET is not configured" });

  try {
    const { data: job, error: lookupError } = await supabase
      .from("jobs")
      .select("id, status, storage_path")
      .eq("id", jobId)
      .single();

    if (lookupError || !job) return res.status(404).json({ error: "Unknown jobId" });
    if (job.status !== "queued") {
      return res.status(409).json({ error: `Job is already ${job.status}` });
    }

    // Pabbly fetches the audio itself, so it needs a URL it can read without
    // credentials. Short-lived and unguessable rather than a public bucket.
    const { data: signed, error: signError } = await supabase.storage
      .from(BUCKET)
      .createSignedUrl(job.storage_path, DOWNLOAD_URL_TTL_SECONDS);

    if (signError) throw signError;

    await supabase
      .from("jobs")
      .update({ status: "processing", file_name: fileName ?? null })
      .eq("id", jobId);

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId,
        fileName: fileName ?? null,
        audioUrl: signed.signedUrl,
        callbackUrl: `${baseUrl()}/api/callback`,
        callbackSecret
      }),
      signal: AbortSignal.timeout(PABBLY_TIMEOUT_MS)
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      await markFailed(jobId, `Pabbly returned ${response.status}: ${detail}`);
      return res.status(502).json({ error: "Pabbly rejected the job", detail });
    }

    // A catch webhook only acknowledges receipt here. The real answer arrives
    // later at /api/callback, and the extension polls /api/status until then.
    return res.status(202).json({ jobId, status: "processing" });
  } catch (err) {
    const message = err?.name === "TimeoutError"
      ? "Pabbly did not respond in time"
      : String(err?.message ?? err);
    console.error("[summarize-audio]", err);
    await markFailed(jobId, message);
    return res.status(502).json({ error: message });
  }
}

async function markFailed(jobId, error) {
  const supabase = getSupabase();
  await supabase
    .from("jobs")
    .update({ status: "error", error: error.slice(0, 1000) })
    .eq("id", jobId)
    .then(null, () => {});
}

function baseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  throw new Error("Set PUBLIC_BASE_URL so Pabbly knows where to call back");
}
