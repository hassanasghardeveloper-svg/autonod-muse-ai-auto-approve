importScripts("vault.js");

// When the extension is installed, updated or reloaded, the old script inside open
// muse.ai tabs stops working. Put a fresh copy into those tabs right away so the
// user never has to remember to press F5.
const MUSE_TABS = ["https://muse.ai/*", "https://*.muse.ai/*"];

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: MUSE_TABS });
  for (const tab of tabs) {
    // tab may be loading / discarded - the manifest scripts cover it later
    chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"], world: "MAIN" }).catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] })
      .catch(() => {});
  }
}

const older = (v, than) => {
  const a = String(v || "0").split(".").map(Number), b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
};

chrome.runtime.onInstalled.addListener((details) => {
  // v1.4.0: "Fill login forms" could also fill muse.ai's own login / password pages.
  // It is now OFF by default - switch it off once for people updating from older versions.
  if (details.reason === "update" && older(details.previousVersion, "1.4.0")) {
    chrome.storage.local.set({ autoFillForms: false });
  }
  // v1.15.0: "Fill login forms" + "Reply in chat" removed (they could only ever touch muse.ai itself)
  if (details.reason === "update" && older(details.previousVersion, "1.15.0")) {
    chrome.storage.local.set({ autoFillForms: false, chatReply: false });
  }
  injectIntoOpenTabs();
});

// ---- all saving goes through here, one write at a time ----
// (several frames/tabs writing at once used to overwrite each other's entries)
let queue = Promise.resolve();
const DUP_MS = 2 * 60 * 1000;

function addLog({ kind: type, detail, host, policy }) {
  return chrome.storage.local.get({ log: [], stats: {} }).then(({ log, stats }) => {
    log.unshift(policy ? { t: Date.now(), type, detail, host, policy } : { t: Date.now(), type, detail, host });
    stats[type] = (stats[type] || 0) + 1; // lifetime counters for the popup
    if (type === "approve") {
      // "approved today" - the big number in the popup (resets every new day)
      const day = new Date().toDateString();
      stats.today = stats.todayDate === day ? (stats.today || 0) + 1 : 1;
      stats.todayDate = day;
    }
    // 300: one Secure Store signup alone writes several lines; "Skipped" rows must survive for the Waiting list
    return chrome.storage.local.set({ log: log.slice(0, 300), stats });
  });
}

async function addCred({ email, password, where, host }) {
  const { creds = [], stats = {}, vault } = await chrome.storage.local.get(["creds", "stats", "vault"]);
  // password lock on: save only the locked version (see vault.js)
  const pw = vault ? { enc: await Vault.seal(vault, password) } : { password };
  const now = Date.now();
  // same Secure Store dialog re-rendered -> update that entry instead of adding a second one
  const same = creds.find((c) => c.where === where && c.host === host && now - c.t < DUP_MS);
  if (same) { delete same.password; delete same.enc; Object.assign(same, { email, ...pw, t: now }); }
  else {
    creds.unshift({ t: now, email, ...pw, where, host });
    stats.passwords = (stats.passwords || 0) + 1;
    if (String(where).startsWith("Secure Store")) stats.secureStore = (stats.secureStore || 0) + 1;
  }
  return chrome.storage.local.set({ creds: creds.slice(0, 200), stats });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "waiting") {
    queue = queue.then(() => setWaiting(sender.tab?.id, msg.count)).catch(() => {});
    return;
  }
  const job = msg?.type === "saveLog" ? addLog : msg?.type === "saveCred" ? addCred : null;
  if (job) queue = queue.then(() => job(msg)).catch((e) => console.warn("[AutoNod]", e));
});

// ---- red number on the toolbar icon: cards that wait for the user (payment / delete) ----
// Kept per muse.ai tab, shown as one total. Saved in storage so the popup can show it too.
async function setWaiting(tabId, count) {
  if (tabId == null) return;
  const { waitingByTab = {}, waiting: before = 0 } = await chrome.storage.local.get(["waitingByTab", "waiting"]);
  if (count > 0) waitingByTab[tabId] = count;
  else delete waitingByTab[tabId];
  const total = await showWaiting(waitingByTab);
  if (total > before) notifyWaiting(total);
}

// The red badge can't be seen when the Muse window is minimized -> a Windows notification can.
function notifyWaiting(total) {
  chrome.notifications.create("autonod-waiting", { // same id: replaces, never stacks
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Muse needs you",
    message: `${total} card${total > 1 ? "s" : ""} waiting for your decision`,
  });
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (id !== "autonod-waiting") return;
  chrome.notifications.clear(id);
  const [tab] = await chrome.tabs.query({ url: MUSE_TABS });
  if (!tab) return;
  await chrome.tabs.update(tab.id, { active: true });
  const win = await chrome.windows.get(tab.windowId);
  await chrome.windows.update(win.id, win.state === "minimized" ? { state: "normal", focused: true } : { focused: true });
});

async function showWaiting(waitingByTab) {
  const total = Object.values(waitingByTab).reduce((a, b) => a + b, 0);
  await chrome.storage.local.set({ waitingByTab, waiting: total });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  chrome.action.setBadgeText({ text: total ? String(total) : "" });
  chrome.action.setTitle({ title: total ? `AutoNod - ${total} card${total > 1 ? "s" : ""} waiting for you` : "AutoNod" });
  return total;
}

// a closed or reloaded muse.ai tab has nothing waiting any more
chrome.tabs.onRemoved.addListener((tabId) => {
  queue = queue.then(() => setWaiting(tabId, 0)).catch(() => {}); // through the queue: no lost writes
});
chrome.runtime.onStartup.addListener(() => showWaiting({})); // old tab ids are gone after a restart

// ---- keep working when the muse.ai tab is in the background or the window is minimized ----
// 1) Chrome's Memory Saver may throw away (discard) a hidden tab -> tell Chrome never to discard muse.ai tabs.
// 2) Chrome slows timers in hidden tabs to once a minute -> wake the page every 30s with a message.
const isMuseUrl = (url) => /^https:\/\/([^/]+\.)?muse\.ai\//.test(url || "");

// A frozen tab (Energy Saver) runs nothing, not even our message: reload it, max once per 10 min.
// Muse's tasks run on Muse's servers, so reloading the page loses nothing.
async function reviveTab(tab) {
  const { revivedAt = {} } = await chrome.storage.session.get("revivedAt");
  if (Date.now() - (revivedAt[tab.id] || 0) < 10 * 60 * 1000) return;
  revivedAt[tab.id] = Date.now();
  await chrome.storage.session.set({ revivedAt });
  chrome.tabs.reload(tab.id).catch(() => {});
}

async function keepMuseTabsAwake() {
  const tabs = await chrome.tabs.query({ url: MUSE_TABS }).catch(() => []);
  for (const tab of tabs) {
    if (tab.autoDiscardable !== false) chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    // thrown away (Memory Saver) or frozen (Energy Saver): the page can't run -> load it again.
    // Muse's tasks run on Muse's servers, so reloading the page loses nothing.
    if (tab.discarded || tab.frozen) { await reviveTab(tab); continue; }
    chrome.tabs.sendMessage(tab.id, { type: "tick" }).catch(() => {
      // no answer = no AutoNod in that page (e.g. after an update) -> put it back
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bridge.js"], world: "MAIN" }).catch(() => {});
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["content.js"] }).catch(() => {});
    });
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "complete" && isMuseUrl(tab.url) && tab.autoDiscardable !== false) {
    chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  }
});

// create only once: creating it again on every service-worker start would push it back forever
chrome.alarms.get("autonod-wake").then((a) => { if (!a) chrome.alarms.create("autonod-wake", { periodInMinutes: 0.5 }); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "autonod-wake") keepMuseTabsAwake(); });
keepMuseTabsAwake();
