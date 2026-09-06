# Audio to Google Doc Summarizer

Press <kbd>Alt</kbd>+<kbd>D</kbd> on a page where an audio file is selected in a file input. The extension uploads it to Supabase Storage, your Pabbly workflow transcribes and summarizes it into a Google Doc, and the Doc opens in a new tab when it's ready.

## Why it's shaped this way

The obvious version — POST the audio to a Vercel route and wait for the Doc URL — fails on two hard limits:

- Vercel caps serverless request bodies at roughly **4.5 MB**. An hour of speech is ~28 MB, so the audio never reaches the function. Setting `bodyParser: false` opts out of Next's parser, not the platform limit.
- A Pabbly catch webhook **acknowledges immediately** and doesn't return the workflow's output, so there's no `docUrl` to send back on that request even if the bytes had arrived. Transcription would also outlive the function timeout.

So the audio goes straight from the browser to storage, and the result arrives asynchronously:

```
extension ──1─> POST /api/upload-url        → { jobId, signedUrl }
          ──2─> PUT  signedUrl (Supabase)    audio bypasses Vercel entirely
          ──3─> POST /api/summarize-audio    → 202 { jobId }
                        └─> Pabbly ──> Gemini + Docs ──> POST /api/callback
          ──4─> GET  /api/status?jobId=...    polled every 30s until done
```

## Layout

| Path | Role |
| --- | --- |
| `manifest.json` | MV3 manifest — `activeTab`, `scripting`, `storage`, `alarms` |
| `background.js` | Probe → upload → start job → poll on `chrome.alarms` |
| `popup.html/.css/.js` | Current job status |
| `options.html/.css/.js` | Backend URL, shared secret, connection test |
| `pages/api/upload-url.js` | Reserves a job row, returns a signed upload URL |
| `pages/api/summarize-audio.js` | Hands Pabbly a signed download URL, returns 202 |
| `pages/api/callback.js` | Pabbly reports the Doc URL here |
| `pages/api/status.js` | What the extension polls |
| `lib/api.js` | Supabase client, auth, method guards |
| `schema.sql` | `jobs` table and the private `audio` bucket |

The API routes are Pages Router (`pages/api/`). On App Router they need rewriting as `route.js` handlers with the Web `Request`/`Response` signature.

## Setup

### 1. Supabase

Create a project, then run `schema.sql` in the SQL editor. It creates the `jobs` table and a **private** `audio` bucket.

From **Project Settings → API**, copy the project URL and the `service_role` key.

> The `service_role` key bypasses row-level security. It belongs only in Vercel's environment variables — never in the extension, and never in a `NEXT_PUBLIC_` variable.

### 2. Vercel

```bash
npm install @supabase/supabase-js
```

Set every variable from `.env.example` in **Project Settings → Environment Variables**. Generate the two secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Deploy.

### 3. Pabbly workflow

Trigger: **Catch Webhook**. It receives this JSON:

```json
{
  "jobId": "uuid",
  "fileName": "standup.m4a",
  "audioUrl": "https://...supabase.co/storage/v1/object/sign/audio/...",
  "callbackUrl": "https://your-domain.vercel.app/api/callback",
  "callbackSecret": "..."
}
```

Steps to build:

1. Download `audioUrl` — it's a signed URL, valid for one hour, no auth header needed.
2. Transcribe and summarize (Gemini, Whisper, whatever you prefer).
3. Create the Google Doc through Pabbly's Google Docs action.
4. **API by Pabbly** → `POST` to `callbackUrl` with body `{ "jobId": "...", "docUrl": "...", "secret": "<callbackSecret>" }`.

Step 4 is the one that's easy to forget. Without it the extension polls for twenty minutes and then reports a timeout. On failure, post `{ "jobId": "...", "error": "...", "secret": "..." }` instead so the user finds out immediately.

### 4. Extension

Edit `manifest.json` and replace `https://your-domain.vercel.app/*` in `host_permissions` with your real domain. If your Supabase project isn't on `*.supabase.co`, fix that entry too.

Load it at `chrome://extensions` → **Developer mode** → **Load unpacked**.

Open the options page, enter the backend URL and the shared secret, and hit **Test connection**. A green "backend is live and the secret matches" means all four routes are reachable and authenticating.

## Behavior worth knowing

- **Polling runs on `chrome.alarms`, not `setInterval`.** An MV3 service worker gets torn down after ~30s idle; alarms wake it back up, so a 10-minute job survives. Chrome clamps packed extensions to a 30-second minimum period.
- **The upload happens in the page, not the worker**, so the `File` object goes over the wire directly with no base64 and no practical size ceiling. If the page's network stack refuses (rare — content scripts bypass page CSP but not CORS), it falls back to handing the bytes to the worker, which is capped at 40 MB because that path is base64 over messaging.
- **Every route requires `X-Extension-Secret`.** The backend URL ships inside the extension source, so an unauthenticated route would let anyone burn your Pabbly task quota.
- **Audio is deleted from storage once the callback lands.** Recordings don't accumulate.
- **`/api/status` reports an error after 20 minutes** rather than leaving the extension polling forever when a workflow dies silently.
- **A retried Pabbly step won't overwrite a finished job** — `/api/callback` no-ops if the job is already `done`.

## Still open

- `probeAudioFile` matches the file by name on the second injection. Two files with the same name in different inputs would be ambiguous; it takes the first.
- There's no retry if the Supabase upload fails halfway. The job row stays `queued` and is never cleaned up — a nightly purge is sketched at the bottom of `schema.sql`.
- Nothing rate-limits `/api/upload-url`. With the shared secret that's probably fine; add a limiter if the secret ever leaks.
