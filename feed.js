// Shared by popup + dashboard: turns a log entry into a row like the website's activity log
// (site favicon, site, what the card asked, a status chip, the time).
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function ago(t) {
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// first domain in a text. Lower case only, so "site.comUsername" (card text glued together) stops at the capital.
// Cards often name the service instead of its address ("posts on your Facebook Pages")
const BRANDS = [
  [/\bfacebook\b/i, "facebook.com"], [/\binstagram\b/i, "instagram.com"], [/\byoutube\b/i, "youtube.com"],
  [/\bpinterest\b/i, "pinterest.com"], [/\btiktok\b/i, "tiktok.com"], [/\blinkedin\b/i, "linkedin.com"],
  [/\bthreads\b/i, "threads.net"], [/\b(twitter|x\.com)\b/i, "x.com"], [/\breddit\b/i, "reddit.com"],
  [/\bgmail\b/i, "mail.google.com"], [/\bgoogle (business|maps)\b/i, "google.com"], [/\byelp\b/i, "yelp.com"],
  [/\bshopify\b/i, "shopify.com"], [/\bcanva\b/i, "canva.com"], [/\bwordpress\b/i, "wordpress.com"],
];
function domainIn(text) {
  const t = String(text || "");
  const m = t.match(/(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+[a-z]{2,})/g) || [];
  for (const hit of m) {
    const d = hit.replace(/^https?:\/\/(www\.)?|^www\./, "");
    if (!/(^|\.)muse\.ai$/.test(d)) return d;
  }
  for (const [re, d] of BRANDS) if (re.test(t)) return d;
  return "";
}

// Secure Store lines like "saved" or "pressed Enter" have no site: they belong to the
// Secure Store line just before them (same login, within 5 minutes). Sets l._site.
function fillSites(log) {
  let last = null;
  for (let i = log.length - 1; i >= 0; i--) { // oldest first
    const l = log[i];
    if (l.type !== "store") continue;
    const own = domainIn(String(l.detail).replace(/ \([^)]*@[^)]*\)$/, ""));
    if (own) last = { site: own, t: l.t };
    else if (last && l.t - last.t < 5 * 60 * 1000) l._site = last.site;
  }
  // "Opened Secure Store" comes before the line that names the site: take the next one's site
  let next = null;
  for (const l of log) { // newest first
    if (l.type !== "store") continue;
    const own = domainIn(String(l.detail).replace(/ \([^)]*@[^)]*\)$/, "")) || l._site;
    if (own) next = { site: own, t: l.t };
    else if (next && next.t - l.t < 5 * 60 * 1000) l._site = next.site;
  }
  return log;
}

// the card's question, without the buttons glued after it ("... fyple.com? Deny Allow")
function question(text) {
  let d = String(text || "").trim();
  const q = d.indexOf("?");
  if (q > 0) d = d.slice(0, q);
  // "Allow Muse to open yelp.com" / "Muse wants to create posts" -> "Open yelp.com" / "Create posts"
  d = d.replace(/^(allow\s+)?muse\s+(wants\s+to|would\s+like\s+to|to)\s+/i, "");
  d = d.charAt(0).toUpperCase() + d.slice(1);
  return d.length > 120 ? d.slice(0, 120) + "…" : d;
}

function parseEntry(l) {
  const detail = String(l.detail || "");
  let site = "", sub = detail, chip = "", cls = "", key = "other";
  if (l.type === "approve") {
    const btn = (detail.match(/^Clicked "([^"]+)"/) || [])[1] || "Allow";
    const card = detail.split(" — ").slice(1).join(" — ") || detail;
    site = domainIn(card);
    sub = question(card);
    chip = /always/i.test(btn) ? "Always allowed" : "Allowed";
    cls = "ok"; key = "ok";
  } else if (l.type === "store") {
    site = domainIn(detail.replace(/ \([^)]*@[^)]*\)$/, "")) || l._site || ""; // not the email's domain
    sub = /Filled/.test(detail) ? "Secure Store · email and new password filled"
      : /saved/i.test(detail) ? "Secure Store · saved"
      : /Enter/.test(detail) ? "Secure Store · pressed Enter"
      : "Secure Store · opened";
    chip = "Login"; cls = "login"; key = "login";
  } else if (l.type === "fill") {
    sub = "Login form filled with your email and a new password";
    chip = "Login"; cls = "login"; key = "login";
  } else if (l.type === "reply") {
    sub = "Sent your email and a password in chat";
    chip = "Replied"; cls = "login"; key = "login";
  } else if (/^Skipped/.test(detail)) {
    const card = detail.replace(/^Skipped \(needs your check\):\s*/, "");
    site = domainIn(card);
    sub = question(card);
    chip = "Waits for you"; cls = "wait"; key = "wait";
  } else {
    sub = detail;
    chip = "Check"; cls = "err"; key = "other";
  }
  return { site, title: site || "muse.ai", sub, chip, cls, key, t: l.t };
}

// Site icon. Muse's agent opens sites in its own cloud browser, so Chrome's favicon cache never has them:
// the icon is loaded from Google's favicon service by site name (only the name is sent, nothing else).
// "Show site icons" off in Settings -> a letter tile, nothing leaves the computer.
let siteIcons = true; // set by the page from storage (siteIcons)
const letterTile = (site) => `<span class="fav"><i>${esc((site || "?")[0])}</i></span>`;
const iconURL = (site) => `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(site)}`;
function favicon(site) {
  site = site || "muse.ai"; // no site in the card: Muse's own icon
  if (!siteIcons) return letterTile(site);
  const url = iconURL(site);
  return `<span class="fav" data-letter="${esc(site[0])}"><img src="${esc(url)}" alt="" referrerpolicy="no-referrer"></span>`;
}
// inline onerror is blocked in extensions, so catch broken favicons here.
// Google answers an unknown site with a tiny generic globe (16px): show the letter instead.
const toLetter = (img) => { img.parentElement.innerHTML = `<i>${esc(img.parentElement.dataset.letter || "?")}</i>`; };
document.addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.parentElement?.dataset.letter) toLetter(img);
}, true);
document.addEventListener("load", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.parentElement?.dataset.letter && img.naturalWidth <= 16) toLetter(img);
}, true);

function rowHTML(l, isNew, i) {
  const e = parseEntry(l);
  return `<li${isNew ? ' class="new"' : ""}${i != null ? ` data-i="${i}"` : ""} title="${esc(l.detail)}">${favicon(e.site)}<span class="who">${esc(e.title)}</span><span class="sub">${esc(e.sub)}</span><span class="meta"><span class="chip ${e.cls}">${esc(e.chip)}</span><time>${ago(e.t)}</time></span></li>`;
}
