import { createClient } from "@supabase/supabase-js";

export const BUCKET = "audio";

let client;

/**
 * Built on first use, not at import. Creating it at module scope means a missing
 * env var throws while Next is loading the route, which produces an HTML 500 the
 * extension can't parse — instead of the JSON error the route would have sent.
 *
 * service_role bypasses RLS and must never reach the browser. Vercel only exposes
 * env vars prefixed NEXT_PUBLIC_, so keep this one unprefixed.
 */
export function getSupabase() {
  client ??= createClient(
    requireEnv("SUPABASE_URL"),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );
  return client;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

/**
 * The extension's endpoint URLs ship inside its source, so every route needs a
 * shared secret. Returns true when the request may proceed.
 */
export function authorize(req, res, { secretEnv = "EXTENSION_SHARED_SECRET" } = {}) {
  const expected = process.env[secretEnv];

  if (!expected) {
    res.status(500).json({ error: `${secretEnv} is not configured` });
    return false;
  }

  const provided = req.headers["x-extension-secret"] ?? req.body?.secret;
  if (!timingSafeEqual(String(provided ?? ""), expected)) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export function methodGuard(req, res, method) {
  if (req.method !== method) {
    res.setHeader("Allow", method);
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  return true;
}

// Constant-time compare so a wrong secret can't be discovered byte by byte.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
