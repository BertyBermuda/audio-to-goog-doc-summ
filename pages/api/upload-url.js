import { randomUUID } from "crypto";
import { getSupabase, BUCKET, authorize, methodGuard } from "../../lib/api";

/**
 * Step 1. Reserves a job row and hands back a signed URL the extension uploads
 * straight to. The audio never passes through this function, which is what gets
 * us past Vercel's ~4.5 MB request body cap.
 */
export default async function handler(req, res) {
  if (!methodGuard(req, res, "POST")) return;
  if (!authorize(req, res)) return;

  const supabase = getSupabase();

  try {
    const jobId = randomUUID();
    const extension = safeExtension(req.body?.fileName);
    const storagePath = `${jobId}${extension}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error) throw error;

    const { error: insertError } = await supabase.from("jobs").insert({
      id: jobId,
      status: "queued",
      file_name: req.body?.fileName ?? null,
      storage_path: storagePath
    });

    if (insertError) throw insertError;

    return res.status(200).json({
      jobId,
      storagePath,
      signedUrl: data.signedUrl,
      token: data.token
    });
  } catch (err) {
    console.error("[upload-url]", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
}

// The filename comes from a web page, so treat it as hostile: keep a short
// alphanumeric extension and nothing else.
function safeExtension(fileName) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(String(fileName ?? ""));
  return match ? `.${match[1].toLowerCase()}` : "";
}
