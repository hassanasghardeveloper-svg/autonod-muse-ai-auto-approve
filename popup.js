// Popup: status, today's count, mode, and shortcuts into the dashboard tab.
// Email + passwords are edited/shown in the dashboard.
const DEFAULTS = {
  enabled: true,
  autoApprove: true,
  preferAlways: true,
  approveLevel: "standard",
  autoFillForms: false,
  chatReply: false,
  secureStore: true,
  email: "",
  pwLength: 16,
  siteIcons: true,
};
const $ = (id) => document.getElementById(id);
const renderModes = setupModes($("modes"), $("modeDesc"));

function render() {
  chrome.storage.local.get({ ...DEFAULTS, creds: [], stats: {}, waiting: 0, log: [] }, (s) => {
    siteIcons = s.siteIcons !== false;
    fillSites(s.log);
    $("enabled").checked = !!s.enabled;
    document.body.classList.toggle("paused", !s.enabled);
    $("stateText").textContent = s.enabled ? "for Muse" : "Paused";
    renderModes(s);

    // big number: approvals today (resets each day)
    const today = s.stats.todayDate === new Date().toDateString() ? s.stats.today || 0 : 0;
    $("today").textContent = today;

    $("pwCount").textContent = s.creds.length;
    $("emailText").textContent = s.email || "Add email";
    $("emailText").className = s.email ? "" : "add";

    // payment / delete / send cards waiting for the user (same number as the red badge)
    const w = s.waiting || 0;
    $("needYou").hidden = !w;
    $("waitTitle").textContent = `${w} card${w > 1 ? "s" : ""} waiting for you`;
    $("waitList").innerHTML = s.log.filter((l) => /^Skipped/.test(String(l.detail))).slice(0, 1).map((l) => rowHTML(l)).join("");

    // the last thing AutoNod did, as one activity row
    $("lastBox").hidden = !s.log.length || w > 0; // the waiting card takes its place
    $("last").innerHTML = s.log.length ? rowHTML(s.log[0]) : "";
  });
}

$("enabled").addEventListener("change", () => chrome.storage.local.set({ enabled: $("enabled").checked }));

// ---- open the dashboard tab (reuse it when it is already open), optionally on a page ----
async function openPanel(view) {
  const url = chrome.runtime.getURL("dashboard.html") + "#" + (view || "overview");
  try {
    const [ctx] = await chrome.runtime.getContexts({ contextTypes: ["TAB"] }).then((all) =>
      all.filter((c) => c.documentUrl && c.documentUrl.startsWith(chrome.runtime.getURL("dashboard.html"))));
    if (ctx && ctx.tabId >= 0) {
      await chrome.tabs.update(ctx.tabId, { active: true, url });
      await chrome.windows.update(ctx.windowId, { focused: true });
      return window.close();
    }
  } catch (_) {}
  await chrome.tabs.create({ url });
  window.close();
}
$("openPanel").addEventListener("click", () => openPanel("overview"));
$("goVault").addEventListener("click", () => openPanel("vault"));
$("goEmail").addEventListener("click", () => openPanel("settings"));
$("needYou").addEventListener("click", () => openPanel("overview"));
$("needYou").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") openPanel("overview"); });

// ---- is the helper actually running on the current muse.ai tab? ----
const isMuse = (url) => /^https:\/\/([^/]+\.)?muse\.ai\//.test(url || "");

function ping(tabId) {
  return new Promise((res) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "ping" }, (r) => res(!chrome.runtime.lastError && !!r?.ok));
    } catch (_) { res(false); }
  });
}

async function checkTab() {
  const bar = $("bar");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isMuse(tab.url)) {
    bar.className = "state";
    bar.textContent = "Open muse.ai to start";
    return;
  }
  if (await ping(tab.id)) {
    bar.className = "state ok";
    bar.textContent = "Working on this muse.ai tab";
    return;
  }
  bar.className = "state bad";
  bar.innerHTML = "Not running <button id='fix'>Reconnect</button>";
  $("fix").addEventListener("click", async () => {
    $("fix").textContent = "…";
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    } catch (_) {}
    if (await ping(tab.id)) return checkTab();
    chrome.tabs.reload(tab.id); // last resort: refresh the page
    setTimeout(checkTab, 2500);
  });
}

chrome.storage.onChanged.addListener(render);
render();
checkTab();
