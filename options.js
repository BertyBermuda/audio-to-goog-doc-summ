const el = id => document.getElementById(id);

const stored = await chrome.storage.local.get(["baseUrl", "secret"]);
el("baseUrl").value = stored.baseUrl ?? "";
el("secret").value = stored.secret ?? "";

el("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    baseUrl: el("baseUrl").value.trim().replace(/\/$/, ""),
    secret: el("secret").value.trim()
  });
  say("Saved.", "ok");
});

el("test").addEventListener("click", async () => {
  const baseUrl = el("baseUrl").value.trim().replace(/\/$/, "");
  const secret = el("secret").value.trim();
  if (!baseUrl) return say("Enter a backend URL first.", "bad");

  el("test").disabled = true;
  say("Testing…");

  try {
    // A job id that cannot exist: 404 proves the route is live and the secret
    // was accepted, while 401 means the secret is wrong.
    const res = await fetch(
      `${baseUrl}/api/status?jobId=00000000-0000-0000-0000-000000000000`,
      { headers: { "X-Extension-Secret": secret } }
    );

    if (res.status === 404) say("Connected — backend is live and the secret matches.", "ok");
    else if (res.status === 401) say("Reached the backend, but the shared secret is wrong.", "bad");
    else if (res.status === 500) say(`Backend error: ${(await text(res)).error ?? "check your Vercel logs"}`, "bad");
    else say(`Unexpected response: ${res.status}`, "bad");
  } catch (err) {
    // Almost always a missing host_permissions entry for this origin.
    say(`Could not reach it: ${err.message}. Check host_permissions in manifest.json.`, "bad");
  } finally {
    el("test").disabled = false;
  }
});

async function text(res) {
  try {
    return await res.json();
  } catch {
    return {};
  }
}

function say(message, kind = "") {
  const status = el("status");
  status.textContent = message;
  status.className = kind;
}
