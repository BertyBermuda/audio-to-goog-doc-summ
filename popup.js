const state = document.getElementById("state");

document.getElementById("options").addEventListener("click", event => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

render((await chrome.storage.local.get("job")).job);
chrome.storage.local.onChanged.addListener(changes => {
  if (changes.job) render(changes.job.newValue);
});

function render(job) {
  state.replaceChildren();

  if (!job) return state.append(row("idle", "Idle"));

  if (job.status === "processing") {
    const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
    state.append(row("busy", `Summarizing… (${elapsed}s)`), fileLine(job.fileName));
    return;
  }

  if (job.status === "done") {
    const link = document.createElement("a");
    link.href = job.docUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open the Google Doc";
    state.append(row("ok", "Summary ready"), fileLine(job.fileName), link);
    return;
  }

  if (job.status === "error") {
    const message = document.createElement("p");
    message.className = "bad-text";
    message.textContent = job.error ?? "Something went wrong.";
    state.append(row("bad", "Failed"), message);
  }
}

function row(kind, text) {
  const wrapper = document.createElement("div");
  wrapper.className = "row";

  const dot = document.createElement("span");
  dot.className = `dot ${kind}`;

  const label = document.createElement("span");
  label.textContent = text;

  wrapper.append(dot, label);
  return wrapper;
}

function fileLine(fileName) {
  const el = document.createElement("div");
  el.className = "file";
  el.textContent = fileName ?? "";
  return el;
}
