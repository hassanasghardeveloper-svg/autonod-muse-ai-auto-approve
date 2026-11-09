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
  injectIntoOpenTabs();
});

// ---- all saving goes through here, one write at a time ----
// (several frames/tabs writing at once used to overwrite each other's entries)
let queue = Promise.resolve();
const DUP_MS = 2 * 60 * 1000;

function addLog({ kind: type, detail, host }) {
  return chrome.storage.local.get({ log: [], stats: {} }).then(({ log, stats }) => {
    log.unshift({ t: Date.now(), type, detail, host });
    stats[type] = (stats[type] || 0) + 1; // lifetime counters for the popup
    if (type === "approve") {
      // "approved today" - the big number in the popup (resets every new day)
      const day = new Date().toDateString();
      stats.today = stats.todayDate === day ? (stats.today || 0) + 1 : 1;
      stats.todayDate = day;
    }
    return chrome.storage.local.set({ log: log.slice(0, 50), stats });
  });
}

function addCred({ email, password, where, host }) {
  return chrome.storage.local.get({ creds: [], stats: {} }).then(({ creds, stats }) => {
    const now = Date.now();
    // same Secure Store dialog re-rendered -> update that entry instead of adding a second one
    const same = creds.find((c) => c.where === where && c.host === host && now - c.t < DUP_MS);
    if (same) Object.assign(same, { email, password, t: now });
    else {
      creds.unshift({ t: now, email, password, where, host });
      stats.passwords = (stats.passwords || 0) + 1;
      if (String(where).startsWith("Secure Store")) stats.secureStore = (stats.secureStore || 0) + 1;
    }
    return chrome.storage.local.set({ creds: creds.slice(0, 50), stats });
  });
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
  const { waitingByTab = {} } = await chrome.storage.local.get("waitingByTab");
  if (count > 0) waitingByTab[tabId] = count;
  else delete waitingByTab[tabId];
  await showWaiting(waitingByTab);
}

async function showWaiting(waitingByTab) {
  const total = Object.values(waitingByTab).reduce((a, b) => a + b, 0);
  await chrome.storage.local.set({ waitingByTab, waiting: total });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  chrome.action.setBadgeText({ text: total ? String(total) : "" });
  chrome.action.setTitle({ title: total ? `AutoNod - ${total} card${total > 1 ? "s" : ""} waiting for you` : "AutoNod" });
}

// a closed or reloaded muse.ai tab has nothing waiting any more
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { waitingByTab = {} } = await chrome.storage.local.get("waitingByTab");
  if (tabId in waitingByTab) { delete waitingByTab[tabId]; showWaiting(waitingByTab); }
});
chrome.runtime.onStartup.addListener(() => showWaiting({})); // old tab ids are gone after a restart
