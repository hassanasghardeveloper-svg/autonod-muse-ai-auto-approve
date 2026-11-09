// Dashboard (a full Chrome tab, like the website's activity window).
// Home / Activity (list + the open card) / Passwords / Settings. Row parsing and icons: feed.js.
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
const TOGGLES = ["enabled", "autoApprove", "preferAlways", "autoFillForms", "chatReply", "secureStore", "siteIcons"];
const MASK = "••••••••••••";
const $ = (id) => document.getElementById(id);
const renderModes = setupModes($("modes"), $("modeDesc"));
const MUSE_URLS = ["https://muse.ai/*", "https://*.muse.ai/*"];

const SVG = (d, w = 1.8) => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = {
  done: SVG('<path d="M3 8.5l3 3 7-7"/>', 2.2),
  copy: SVG('<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 3.5V3A1.5 1.5 0 0 0 9 1.5H3A1.5 1.5 0 0 0 1.5 3v6A1.5 1.5 0 0 0 3 10.5h.5"/>', 1.5),
  eye: SVG('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>', 1.5),
  eyeOff: SVG('<path d="M2 2l12 12M6.5 6.6A2 2 0 0 0 9.4 9.5M4.2 4.6C2.6 5.8 1.5 8 1.5 8S4 12.5 8 12.5c1.3 0 2.4-.4 3.4-1M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.6 1.1-1.7 2.3"/>', 1.5),
};
const siteOf = (c) => (String(c.where).match(/https?:\/\/(?:www\.)?([a-z0-9.-]+?)(?=[A-Z]|\/|\s|$)/) || [])[1] || domainIn(c.where) || c.host;
const NAMES = { overview: "Home", activity: "Activity", vault: "Passwords", settings: "Settings" };

let state = { creds: [], log: [], stats: {} };
let filter = "all";
let selected = 0; // index in state.log of the open card
let selectedT = 0; // ...remembered by its time, so new rows on top do not move it
let seenTop = null;
const revealed = new Set();

// ---------- menu (the address keeps the page: dashboard.html#activity) ----------
function show(view, f) {
  if (!$(view)) view = "overview";
  if (f) { setFilter(f); renderFeed(); }
  markNav(view);
  document.querySelectorAll(".view").forEach((v) => (v.hidden = v.id !== view));
  $("crumb").textContent = NAMES[view];
  if (location.hash.slice(1) !== view) history.replaceState(null, "", "#" + view);
  document.querySelector("main").scrollTop = 0;
}
// Activity and Waiting are one page; Waiting is the Activity page filtered to the cards left for you
function markNav(view) {
  document.querySelectorAll("aside .nav").forEach((b) => {
    const on = b.dataset.view === view && (view !== "activity" || (b.dataset.filter === "wait") === (filter === "wait"));
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
}
// a new page from the menu starts without the old search
function clearFind() { if ($("find").value) { $("find").value = ""; renderVault(); } }
document.querySelectorAll("aside .nav").forEach((b) => b.addEventListener("click", () => clearFind()));
document.querySelectorAll("aside .nav").forEach((b) => b.addEventListener("click", () => show(b.dataset.view, b.dataset.filter || (b.dataset.view === "activity" ? "all" : ""))));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => show(b.dataset.goto, "all")));
$("goSettings").addEventListener("click", () => { show("settings"); $("email").focus(); });
window.addEventListener("hashchange", () => show(location.hash.slice(1)));

// ---------- two clicks to clear ----------
function confirmClick(btn, label, action) {
  btn.addEventListener("click", () => {
    if (!btn.classList.contains("sure")) {
      btn.classList.add("sure");
      btn.textContent = "Sure? Click again";
      setTimeout(() => { btn.classList.remove("sure"); btn.textContent = label; }, 3000);
      return;
    }
    btn.classList.remove("sure");
    btn.textContent = label;
    action();
  });
}
confirmClick($("clearLog"), "Clear activity", () => chrome.storage.local.set({ log: [] }));
confirmClick($("clearCreds"), "Clear all", () => chrome.storage.local.set({ creds: [] }));

// ---------- activity: filters, search, the open card ----------
function setFilter(f) {
  filter = f;
  markNav("activity");
  $("filters").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.f === f)));
}
$("filters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-f]");
  if (!b) return;
  setFilter(b.dataset.f);
  show("activity");
  renderFeed();
});

const query = () => $("find").value.trim().toLowerCase();
const matches = (l) => {
  const q = query();
  if (!q) return true;
  const e = parseEntry(l);
  return `${e.title} ${e.sub} ${l.detail}`.toLowerCase().includes(q);
};

function renderFeed() {
  const at = state.log.findIndex((l) => l.t === selectedT);
  if (at >= 0) selected = at;
  const rows = state.log.map((l, i) => ({ l, i })).filter(({ l }) => (filter === "all" || parseEntry(l).key === filter) && matches(l));
  if (!rows.some((r) => r.i === selected)) selected = rows.length ? rows[0].i : -1;
  selectedT = state.log[selected]?.t || 0;
  $("feed").innerHTML = rows.length
    ? rows.map(({ l, i }) => rowHTML(l, false, i)).join("")
    : `<li class="empty"><b>${state.log.length ? "Nothing here" : "No activity yet"}</b>${state.log.length ? "Try another filter or search." : "Start a task in Muse and the cards show up here."}</li>`;
  $("feed").querySelectorAll("li[data-i]").forEach((li) => li.classList.toggle("sel", +li.dataset.i === selected));
  renderOpen();
}

function renderOpen() {
  const l = state.log[selected];
  if (!l) { $("open").innerHTML = `<div class="empty" style="padding:60px 20px"><b>Pick a row</b>Its card opens here.</div>`; return; }
  const e = parseEntry(l);
  const when = new Date(l.t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const muse = siteIcons ? iconURL("muse.ai") : "icons/icon32.png";
  let card = "";
  if (e.key === "ok") {
    const always = /always/i.test(e.chip);
    card = `<div class="acts"><span class="${always ? "" : "on"}">Allow</span>${always ? '<span class="on">Always allow</span>' : ""}<span>Deny</span><span class="by"><img src="icons/icon32.png" alt="">Clicked by AutoNod</span></div>`;
  } else if (e.key === "wait") {
    card = `<div class="acts"><span class="waiting">Allow</span><span>Deny</span><span class="by" style="color:var(--wait)">Left for you</span></div>`;
  } else if (e.key === "login") {
    card = `<div class="acts"><span class="on">Add</span><span class="by"><img src="icons/icon32.png" alt="">Filled by AutoNod</span></div>`;
  }
  const ask = e.key === "login" ? (e.site ? `Save a login for ${e.site} in Secure Store.` : e.sub) : e.sub;
  $("open").innerHTML = `<div class="ask">
    <div class="who">${favicon(e.site)}<div><b>${esc(e.title)}</b><small>${esc(when)}</small></div><span class="chip ${e.cls}" style="margin-left:auto">${esc(e.chip)}</span></div>
    <div class="museCard"><div class="from"><img src="${esc(muse)}" alt="">Muse asked</div><p>${esc(ask)}</p>${card}</div>
    ${e.key === "wait" ? `<button class="openBtn" id="openMuse2">Open muse.ai to decide</button>` : ""}
    <dl class="facts"><dt>Site</dt><dd>${esc(e.site || "muse.ai")}</dd><dt>When</dt><dd>${esc(when)}</dd><dt>What happened</dt><dd>${esc(e.chip)}</dd></dl>
    <div class="raw">${esc(l.detail)}</div>
  </div>`;
  $("openMuse2")?.addEventListener("click", openMuse);
}

$("feed").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-i]");
  if (!li) return;
  selected = +li.dataset.i;
  selectedT = state.log[selected]?.t || 0;
  $("feed").querySelectorAll("li[data-i]").forEach((x) => x.classList.toggle("sel", x === li));
  renderOpen();
});
// Home rows open their card on the Activity page
["recent", "waitList"].forEach((id) => $(id).addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-i]");
  if (!li) return;
  selected = +li.dataset.i;
  selectedT = state.log[selected]?.t || 0;
  show("activity", id === "waitList" ? "wait" : "all");
  renderFeed();
}));

// keyboard: "/" searches, arrows move through the list
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement.tagName !== "INPUT") { e.preventDefault(); $("find").focus(); return; }
  if (!$("activity").hidden && (e.key === "ArrowDown" || e.key === "ArrowUp") && document.activeElement.tagName !== "INPUT") {
    const ids = [...$("feed").querySelectorAll("li[data-i]")].map((li) => +li.dataset.i);
    const at = ids.indexOf(selected);
    const next = ids[Math.max(0, Math.min(ids.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next != null) { e.preventDefault(); selected = next; selectedT = state.log[next].t; renderFeed(); $("feed").querySelector("li.sel")?.scrollIntoView({ block: "nearest" }); }
  }
});
$("find").addEventListener("input", () => {
  if ($("vault").hidden && $("activity").hidden) show("activity");
  renderFeed();
  renderVault();
});

// ---------- jump to the muse.ai tab ----------
async function openMuse() {
  const tabs = await chrome.tabs.query({ url: MUSE_URLS });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) return chrome.tabs.create({ url: "https://muse.ai/" });
  chrome.tabs.update(tab.id, { active: true });
  chrome.windows.update(tab.windowId, { focused: true });
}
$("openMuse").addEventListener("click", openMuse);

// ---------- passwords ----------
function renderVault() {
  const q = query();
  const list = state.creds.map((c, i) => ({ c, i })).filter(({ c }) => !q || `${siteOf(c)} ${c.email}`.toLowerCase().includes(q));
  $("creds").innerHTML = list.length
    ? list.map(({ c, i }) => {
        const on = revealed.has(i);
        const site = siteOf(c);
        return `<div class="vrow">${favicon(site)}<span class="site">${esc(site)}</span><span class="mail">${esc(c.email)}</span><span class="when">${ago(c.t)}</span>
          <span class="pw${on ? " shown" : ""}">${on ? esc(c.password) : MASK}</span>
          <span style="display:flex;gap:6px"><button class="ibtn" data-show="${i}" aria-label="${on ? "Hide" : "Show"} password for ${esc(site)}">${on ? I.eyeOff : I.eye}</button>
          <button class="ibtn" data-copy="${i}" aria-label="Copy password for ${esc(site)}">${I.copy}</button></span></div>`;
      }).join("")
    : `<div class="empty"><b>${q ? "No match" : "No passwords yet"}</b>${q ? "Search by site or email." : "AutoNod saves one here each time it fills a Secure Store login."}</div>`;
}
$("creds").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.show !== undefined) {
    const i = +b.dataset.show;
    revealed.has(i) ? revealed.delete(i) : revealed.add(i);
    renderVault();
  } else if (b.dataset.copy !== undefined) {
    navigator.clipboard.writeText(state.creds[+b.dataset.copy].password);
    b.classList.add("done");
    b.innerHTML = I.done;
    setTimeout(() => { b.classList.remove("done"); b.innerHTML = I.copy; }, 1500);
  }
});

// ---------- render everything from storage ----------
function render() {
  chrome.storage.local.get({ ...DEFAULTS, creds: [], stats: {}, log: [], waiting: 0 }, (s) => {
    if (s.creds.length !== state.creds.length) revealed.clear();
    fillSites(s.log);
    state = s;
    siteIcons = s.siteIcons !== false;

    TOGGLES.forEach((k) => ($(k).checked = !!s[k]));
    renderModes(s);
    if (document.activeElement !== $("email")) $("email").value = s.email;
    if (document.activeElement !== $("pwLength")) $("pwLength").value = s.pwLength;
    $("stateText").textContent = s.enabled ? "On" : "Paused";
    document.body.classList.toggle("paused", !s.enabled);
    $("needEmail").style.display = s.email ? "none" : "";

    // numbers
    const today = s.stats.todayDate === new Date().toDateString() ? s.stats.today || 0 : 0;
    const big = $("today");
    if (+big.textContent < today && big.dataset.ready) { big.classList.remove("pop"); void big.offsetWidth; big.classList.add("pop"); }
    big.textContent = today;
    big.dataset.ready = "1";
    $("allApproved").textContent = s.stats.approve || 0;
    $("allPw").textContent = Math.max(s.stats.passwords || 0, s.creds.length);
    const w = s.waiting || 0;
    $("waitNum").textContent = w;
    $("waitTile").classList.toggle("warn", w > 0);

    // waiting cards (same number as the red badge)
    $("needYou").hidden = !w;
    $("waitTitle").textContent = `${w} card${w > 1 ? "s" : ""} waiting for you`;
    const skipped = s.log.map((l, i) => ({ l, i })).filter(({ l }) => /^Skipped/.test(String(l.detail))).slice(0, w);
    $("waitList").innerHTML = skipped.map(({ l, i }) => rowHTML(l, false, i)).join("");

    // menu counts and filter counts
    const n = { all: s.log.length, ok: 0, login: 0, wait: 0 };
    s.log.forEach((l) => { const k = parseEntry(l).key; if (k in n) n[k]++; });
    $("nAll").textContent = n.all; $("nOk").textContent = n.ok; $("nLogin").textContent = n.login; $("nWait").textContent = n.wait;
    $("cAll").textContent = n.all || ""; $("cWait").textContent = w || ""; $("cPw").textContent = s.creds.length || "";

    // latest on Home; new rows slide in
    const newest = s.log[0]?.t || 0;
    $("recent").innerHTML = s.log.length
      ? s.log.slice(0, 8).map((l, i) => rowHTML(l, seenTop !== null && l.t > seenTop, i)).join("")
      : `<li class="empty"><b>Nothing yet</b>Start a task in Muse. Each card AutoNod answers shows up here.</li>`;
    seenTop = newest;

    renderFeed();
    renderVault();
  });
}

TOGGLES.forEach((k) => $(k).addEventListener("change", () => chrome.storage.local.set({ [k]: $(k).checked })));

let saveTimer;
function status(msg) { $("status").textContent = msg; setTimeout(() => ($("status").textContent = ""), 2000); }
function autoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const email = $("email").value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return status("Email doesn't look valid");
    const pwLength = Math.max(8, Math.min(64, parseInt($("pwLength").value, 10) || 16));
    chrome.storage.local.set({ email, pwLength }, () => status("Saved ✓"));
  }, 500);
}
$("email").addEventListener("input", autoSave);
$("pwLength").addEventListener("input", autoSave);

// ---------- is AutoNod running in your muse.ai tab? (the dashboard is its own tab, so look for muse.ai) ----------
function ping(tabId) {
  return new Promise((res) => {
    try { chrome.tabs.sendMessage(tabId, { type: "ping" }, (r) => res(!chrome.runtime.lastError && !!r?.ok)); } catch (_) { res(false); }
  });
}
async function checkTab() {
  const bar = $("bar");
  const tabs = await chrome.tabs.query({ url: MUSE_URLS });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) { bar.className = "state"; bar.textContent = "No muse.ai tab open"; return; }
  if (await ping(tab.id)) { bar.className = "state ok"; bar.textContent = "Working on muse.ai"; return; }
  bar.className = "state bad";
  bar.innerHTML = "Not running <button id='fix'>Reconnect</button>";
  $("fix").addEventListener("click", async () => {
    $("fix").textContent = "…";
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"], world: "MAIN" });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] });
    } catch (_) {}
    if (await ping(tab.id)) return checkTab();
    chrome.tabs.reload(tab.id);
    setTimeout(checkTab, 2500);
  });
}
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete") checkTab(); });
chrome.tabs.onRemoved.addListener(() => setTimeout(checkTab, 300));
setInterval(checkTab, 15000);

chrome.storage.onChanged.addListener(render);
setInterval(render, 30000); // keep "2m" times fresh

show(location.hash.slice(1) || "overview");
render();
checkTab();
