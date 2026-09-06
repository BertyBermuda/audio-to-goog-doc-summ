// Alt+D takes the audio file selected in a file input on the active page,
// uploads it straight to Supabase Storage via a signed URL, asks the backend to
// start a job, then polls until the Google Doc URL comes back.
//
// The audio never travels through the Vercel function, which is what gets us
// past its request body cap. Polling runs on chrome.alarms rather than a timer
// so it survives the service worker being torn down mid-job.

const POLL_ALARM = "poll-job";
const POLL_MINUTES = 0.5; // Chrome clamps packed extensions to 30s minimum
const GIVE_UP_MS = 20 * 60 * 1000;

// Only used by the fallback path, where bytes cross the page->worker boundary.
const FALLBACK_MAX_BYTES = 40 * 1024 * 1024;

chrome.commands.onCommand.addListener(async command => {
  if (command !== "run_summary") return;

  const { job } = await chrome.storage.local.get("job");
  if (job?.status === "processing") {
    return note("A summary is already running.", "warn");
  }

  try {
    await start();
  } catch (err) {
    await fail(String(err?.message ?? err));
  }
});

async function start() {
  const { baseUrl, secret } = await settings();
  if (!baseUrl) throw new Error("No backend URL saved. Open the extension options first.");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");

  badge("…", "#1a73e8");

  // 1. Find out what we're dealing with before reserving anything server-side.
  const probe = await inject(tab.id, probeAudioFile);
  if (probe.error) throw new Error(probe.error);

  // 2. Reserve a job row and a signed upload URL.
  const reserved = await call(baseUrl, secret, "POST", "/api/upload-url", {
    fileName: probe.name
  });

  // 3. Push the bytes from the page directly at Supabase.
  const upload = await inject(tab.id, uploadAudioFile, [
    reserved.signedUrl,
    probe.name,
    FALLBACK_MAX_BYTES
  ]);

  if (!upload.ok) {
    if (!upload.dataBase64) throw new Error(upload.error || "Upload failed.");
    // The page's network stack refused; retry from the worker, where
    // host_permissions exempt us from CORS.
    await uploadFromWorker(reserved.signedUrl, upload.dataBase64, probe.type);
  }

  // 4. Kick off the workflow and start watching for the result.
  await call(baseUrl, secret, "POST", "/api/summarize-audio", {
    jobId: reserved.jobId,
    fileName: probe.name
  });

  await chrome.storage.local.set({
    job: {
      jobId: reserved.jobId,
      fileName: probe.name,
      status: "processing",
      startedAt: Date.now()
    }
  });

  chrome.alarms.create(POLL_ALARM, { periodInMinutes: POLL_MINUTES });
}

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== POLL_ALARM) return;

  const { job } = await chrome.storage.local.get("job");
  if (!job || job.status !== "processing") return chrome.alarms.clear(POLL_ALARM);

  if (Date.now() - job.startedAt > GIVE_UP_MS) {
    chrome.alarms.clear(POLL_ALARM);
    return fail("Gave up waiting for the summary after 20 minutes.");
  }

  try {
    const { baseUrl, secret } = await settings();
    const result = await call(baseUrl, secret, "GET", `/api/status?jobId=${encodeURIComponent(job.jobId)}`);

    if (result.status === "done" && result.docUrl) {
      chrome.alarms.clear(POLL_ALARM);
      await chrome.storage.local.set({ job: { ...job, status: "done", docUrl: result.docUrl } });
      chrome.tabs.create({ url: result.docUrl });
      badge("✓", "#188038", 5000);
    } else if (result.status === "error") {
      chrome.alarms.clear(POLL_ALARM);
      await fail(result.error || "The backend reported an error.");
    }
  } catch (err) {
    // A single failed poll is usually a blip; the next alarm tries again.
    console.warn("[summarizer] poll failed:", err);
  }
});

/* ---------- injected into the page ---------- */

// Returns metadata only, so nothing large crosses the boundary on this pass.
function probeAudioFile() {
  const file = [...document.querySelectorAll('input[type="file"]')]
    .flatMap(input => [...(input.files ?? [])])
    .find(f => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac|aiff?)$/i.test(f.name));

  if (!file) return { error: "No audio file is selected in a file input on this page." };
  return { name: file.name, type: file.type || "audio/mpeg", size: file.size };
}

// PUTs the File object itself — no base64, so there's no practical size ceiling.
function uploadAudioFile(signedUrl, fileName, fallbackMaxBytes) {
  const file = [...document.querySelectorAll('input[type="file"]')]
    .flatMap(input => [...(input.files ?? [])])
    .find(f => f.name === fileName);

  if (!file) return { ok: false, error: "The audio file disappeared from the page." };

  return fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "audio/mpeg" },
    body: file
  })
    .then(async res => {
      if (res.ok) return { ok: true };
      return { ok: false, error: `Storage returned ${res.status}: ${(await res.text()).slice(0, 200)}` };
    })
    .catch(err => {
      // Usually the page's CSP or a network policy. Hand the bytes back so the
      // worker can retry, unless the file is too big to pass through messaging.
      if (file.size > fallbackMaxBytes) {
        return { ok: false, error: `Direct upload failed (${err.message}) and the file is too large to retry.` };
      }
      return new Promise(resolve => {
        const reader = new FileReader();
        reader.onerror = () => resolve({ ok: false, error: "Could not read the file." });
        reader.onload = () => resolve({
          ok: false,
          error: String(err.message),
          dataBase64: String(reader.result).split(",", 2)[1]
        });
        reader.readAsDataURL(file);
      });
    });
}

/* ---------- helpers ---------- */

async function inject(tabId, func, args = []) {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  } catch {
    throw new Error("Chrome won't let the extension run on this page.");
  }
  const result = frames?.[0]?.result;
  if (!result) throw new Error("The page returned nothing.");
  return result;
}

async function uploadFromWorker(signedUrl, dataBase64, mimeType) {
  const bin = atob(dataBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const res = await fetch(signedUrl, {
    method: "PUT",
    headers: { "Content-Type": mimeType || "audio/mpeg" },
    body: bytes
  });
  if (!res.ok) throw new Error(`Storage returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

async function call(baseUrl, secret, method, path, body) {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      "X-Extension-Secret": secret ?? "",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${path} returned non-JSON (${res.status}): ${raw.slice(0, 200)}`);
  }
  if (!res.ok) throw new Error(data.error || `${path} returned ${res.status}`);
  return data;
}

const settings = () => chrome.storage.local.get(["baseUrl", "secret"]);

async function fail(message) {
  badge("!", "#d93025", 10000);
  const { job } = await chrome.storage.local.get("job");
  await chrome.storage.local.set({ job: { ...(job ?? {}), status: "error", error: message } });
  console.error("[summarizer]", message);
}

async function note(message, kind) {
  badge(kind === "warn" ? "•" : "", "#f9ab00", 3000);
  console.info("[summarizer]", message);
}

function badge(text, color, clearAfter) {
  chrome.action.setBadgeText({ text });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
  if (clearAfter) setTimeout(() => chrome.action.setBadgeText({ text: "" }), clearAfter);
}
