// AutoNod - content script
(() => {
  // Can be injected several times (manifest, background re-inject, after an update).
  // The NEWEST copy wins: every copy sees the same page attribute, older ones stop themselves.
  const TOKEN = Math.random().toString(36).slice(2);
  document.documentElement.setAttribute("data-autonod-owner", TOKEN);

  const DEFAULTS = {
    enabled: true,
    autoApprove: true,
    preferAlways: true,
    approveLevel: "standard", // safe | standard | autopilot (set by the mode)
    secureStore: true,
    approvePosts: true, // Standard: also press action buttons (Share reel, Post, Send, Upload...) - not deletes
    openReview: true, // click Muse's "N tasks need review -> Review" bar when no card is on screen
    email: "",
    pwLength: 16,
  };

  // Matches e.g. "Allow", "Allow once", "Always allow uploads to this site", "Deny"
  const ALLOW_RE = /^(allow|approve|accept|confirm)\b/i;
  const ALWAYS_RE = /^(always allow|allow always|always approve)\b/i;
  const DENY_RE = /^(deny|reject|decline|don'?t\b|do not\b|block)/i;
  // ---- what waits for the user depends on the mode (approveLevel) ----
  // Money: waits in EVERY mode (checked on the question AND on the button that would be clicked)
  const MONEY_RE = /\b(pay|payment|purchase|buy|checkout|place (an |the )?order|subscribe|subscription|billing|invoice|credit card|card (number|details)|cvv|cvc|transfer|send money|donat\w*|upgrade|free trial|gift card|wallet)\b|[$€£₹]\s?\d|\b(usd|eur|gbp|pkr|rs\.?)\s?\d/i;
  const MONEY_POLICY_RE = /(purchase|payment|checkout|billing|order|invoice|charge|payout|transfer)/i;
  // Deleting: waits in Safe; in Standard only when it is the real action (not a list like "create, edit ... and delete")
  const DELETE_RE = /\b(delete|remove|erase|wipe|uninstall|cancel (my|the|your) (account|subscription))\b/i;
  const DELETE_POLICY_RE = /(delete|trash|remove|purge|erase|destroy)/i; // also batchDelete, emptyTrash
  const SEND_POLICY_RE = /(send|reply|forward)/i; // e-mail / DMs wait in Standard
  // "Always allow" is permanent - never for these (a one-time "Allow" instead)
  const NO_ALWAYS_POLICY_RE = /(send|reply|forward|share|invite|comment|post|publish|upload|delete|trash|remove)/i;
  const BUNDLE_RE = /\b(create|edit|schedule|publish|post|upload|manage|update|read|view)\b/i;
  // Posting / messaging: waits in Safe only
  const ACTION_RE = /\b(post|posts|publish|send|message|messages|email|comment|reply|share|tweet|upload)\b/i;
  // Only the card's question is checked (not long descriptions / captions)
  const questionOf = (text) => {
    const i = text.indexOf("?");
    return (i > 0 && i < 400 ? text.slice(0, i + 1) : text.slice(0, 300));
  };

  // One approval -> { target } (click it) or { reason } (leave it for the user), or null (no buttons)
  function decide(n) {
    const { always, once, action } = buttonsIn(n);
    if (!always && !once && !action) return null;
    const text = (n.innerText || "").replace(/\s+/g, " ");
    const q = questionOf(text);
    const policy = n.getAttribute("data-autonod-policy") || "";
    const level = settings.approveLevel || "standard";
    if (!n.hasAttribute("data-autonod-scanned")) return { text, policy, reason: "could not be read (reload the Muse tab)" };

    // "Always allow" is permanent: only for low-risk cards (e.g. opening a website)
    const okAlways = settings.preferAlways && !NO_ALWAYS_POLICY_RE.test(policy) && !ACTION_RE.test(q);
    const target = (okAlways ? always || once : once || always) || action;
    const label = btnText(target);
    const d = { text, policy, target };

    const money = q.match(MONEY_RE) || label.match(MONEY_RE) || policy.match(MONEY_POLICY_RE);
    if (money) return { ...d, reason: `mentions "${money[0]}"` };
    if (level === "autopilot") return d;
    if (DELETE_POLICY_RE.test(policy)) return { ...d, reason: "is a delete" };
    const del = q.match(DELETE_RE);
    if (target === action) {
      // Standard + "Action buttons": ANY button Muse shows instead of Allow - Share reel, Post,
      // Publish, Upload, Send, Share, Save... is pressed. Only deleting (and money, above) waits.
      const delBtn = label.match(DELETE_RE);
      if (level === "standard" && settings.approvePosts && !delBtn && !(del && !BUNDLE_RE.test(q))) return d;
      return { ...d, reason: delBtn ? `wants to "${label}"` : del ? `mentions "${del[0]}"` : `wants to "${label}"` };
    }
    if (level === "safe") {
      const act = del || q.match(ACTION_RE);
      return act ? { ...d, reason: `mentions "${act[0]}"` } : d;
    }
    if (SEND_POLICY_RE.test(policy) && !settings.approvePosts) return { ...d, reason: "lets Muse send messages" };
    if (del && !BUNDLE_RE.test(q)) return { ...d, reason: `mentions "${del[0]}"` };
    return d;
  }

  // legacy path only (no Muse marker, no policy): text rules
  function waitReason(text) {
    const q = questionOf(text);
    const level = settings.approveLevel || "standard";
    const money = q.match(MONEY_RE);
    if (money) return `mentions "${money[0]}"`;
    if (level === "autopilot") return "";
    const del = q.match(DELETE_RE);
    if (level === "safe") { const act = del || q.match(ACTION_RE); return act ? `mentions "${act[0]}"` : ""; }
    return del && !BUNDLE_RE.test(q) ? `mentions "${del[0]}"` : "";
  }


  let settings = { ...DEFAULTS };

  // ---------- helpers ----------
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };

  const btnText = (el) =>
    (el.innerText || el.textContent || el.getAttribute("aria-label") || el.value || "")
      .replace(/\s+/g, " ")
      .trim();

  // Collect every element, also inside shadow DOMs
  function deepAll(root = document, out = []) {
    for (const el of root.querySelectorAll("*")) {
      out.push(el);
      if (el.shadowRoot) deepAll(el.shadowRoot, out);
    }
    return out;
  }

  const CLICKABLE = 'button, [role="button"], a, input[type="button"], input[type="submit"]';

  const allButtons = (root = document) => [...root.querySelectorAll(CLICKABLE)].filter(visible);

  // document + every shadow root (cheap: no text is read here)
  const allRoots = () => [document, ...deepAll().filter((el) => el.shadowRoot).map((el) => el.shadowRoot)];
  const CHOICE_START_RE = /^\s*(allow|approve|accept|confirm|always|deny|reject|decline|don|block)/i;

  // Find short-text clickable things (real buttons OR styled divs/spans) whose label matches.
  // Only looks at text pieces that START with one of the choice words, so long chats stay fast.
  function findChoiceButtons() {
    const found = new Set();
    const consider = (el) => {
      if (!el) return;
      const raw = (el.textContent || el.getAttribute("aria-label") || el.value || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 60 || raw.endsWith("?")) return; // skip titles like "Allow Muse to ...?"
      if (!(ALLOW_RE.test(raw) || ALWAYS_RE.test(raw) || DENY_RE.test(raw))) return;
      const clickable = el.closest(CLICKABLE) || (getComputedStyle(el).cursor === "pointer" ? el : null);
      if (clickable) found.add(clickable);
    };
    for (const root of allRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (CHOICE_START_RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) consider(n.parentElement);
      // icon buttons that only have an aria-label / value
      root.querySelectorAll('[aria-label], input[type="button"], input[type="submit"]').forEach(consider);
    }
    const arr = [...found].filter(visible);
    // keep the innermost element for each label
    return arr.filter((el) => !arr.some((o) => o !== el && el.contains(o)));
  }

  function realClick(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", o));
    el.dispatchEvent(new MouseEvent("mousedown", o));
    el.dispatchEvent(new PointerEvent("pointerup", o));
    el.dispatchEvent(new MouseEvent("mouseup", o));
    el.click();
  }

  function genPassword(len) {
    len = Math.max(8, Math.min(64, Number(len) || 16));
    const sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#$%^&*-_=+?"];
    const all = sets.join("");
    const rand = (n) => {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] % n;
    };
    const chars = sets.map((s) => s[rand(s.length)]);
    while (chars.length < len) chars.push(all[rand(all.length)]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = rand(i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join("");
  }

  // ---------- extension-alive check ----------
  // After the extension is reloaded/updated, this old copy of the script can no longer
  // save anything. Stop working and ask for a page refresh instead of failing silently.
  let dead = false, observer = null, timerId = 0;
  function alive() {
    if (dead) return false;
    let ok = false;
    try { ok = !!chrome.runtime?.id; } catch (_) {}
    if (ok && document.documentElement.getAttribute("data-autonod-owner") === TOKEN) return true;
    // extension reloaded, or a newer copy took over: stop completely (no double clicks)
    dead = true;
    observer?.disconnect();
    clearInterval(timerId);
    console.log("[AutoNod] this copy stopped (newer copy took over or extension reloaded)");
    return false;
  }

  // ---------- on-page notifications (toasts) ----------
  // Small cards in the bottom-left corner of muse.ai. They live in a shadow root so
  // muse's own CSS can't change them. Colours follow AutoNod's light / dark setting.
  const TOAST_ICONS = {
    ok: '<path d="M3 8.5l3 3 7-7"/>',
    approve: '<path d="M3 8.5l3 3 7-7"/>',
    store: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5 7V5a3 3 0 0 1 6 0v2"/>',
    fill: '<path d="M3 13h10M4 10l6.5-6.5 2 2L6 12H4z"/>',
    reply: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>',
    warn: '<path d="M8 3.5v5.5M8 12v.3"/>',
    err: '<path d="M8 3.5v5.5M8 12v.3"/>',
  };
  const TOAST_CSS = `
    :host { all: initial; }
    .box { position: fixed; left: 16px; bottom: 16px; z-index: 2147483647; display: flex; flex-direction: column; gap: 8px;
      font: 13px "Segoe UI", system-ui, sans-serif; pointer-events: none; -webkit-font-smoothing: antialiased; }
    .t { --bg: #fff; --fg: #0f1520; --mut: #5b6474; --line: #e3e8ef;
      position: relative; width: 300px; display: flex; gap: 10px; align-items: flex-start; padding: 11px 12px 13px;
      background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; overflow: hidden;
      box-shadow: 0 1px 2px rgba(15,21,32,.06), 0 14px 34px -14px rgba(15,21,32,.35); pointer-events: auto;
      opacity: 0; transform: translateY(10px) scale(.98); transition: opacity .25s cubic-bezier(.22,1,.36,1), transform .35s cubic-bezier(.22,1,.36,1); }
    .dark .t { --bg: #131824; --fg: #e9edf3; --mut: #929bab; --line: rgba(255,255,255,.08); box-shadow: 0 16px 40px -16px rgba(0,0,0,.85); }
    .t.in { opacity: 1; transform: none; }
    .ic { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; flex: none; }
    .ok .ic, .approve .ic { background: #e5f5ec; color: #17713f; }
    .store .ic, .fill .ic, .reply .ic { background: #e6f0fe; color: #1a73e8; }
    .warn .ic { background: #fff1dc; color: #8a4b00; }
    .err .ic { background: #fde8e8; color: #d93025; }
    .dark .ok .ic, .dark .approve .ic { background: rgba(122,217,166,.13); color: #7ad9a6; }
    .dark .store .ic, .dark .fill .ic, .dark .reply .ic { background: rgba(90,185,252,.14); color: #5ab9fc; }
    .dark .warn .ic { background: rgba(247,189,110,.13); color: #f7bd6e; }
    .dark .err .ic { background: #3b1d1d; color: #f28b82; }
    .tx { flex: 1; min-width: 0; }
    .ti { font-weight: 600; line-height: 1.3; }
    .ti small { font-weight: 400; color: var(--mut); margin-left: 4px; }
    .de { margin-top: 2px; color: var(--mut); font-size: 12px; line-height: 1.4; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
    .x { border: 0; background: none; color: var(--mut); font: 16px/1 sans-serif; padding: 2px 4px; margin: -2px -4px 0 0; cursor: pointer; border-radius: 6px; }
    .x:hover { background: rgba(127,127,127,.15); color: var(--fg); }
    .bar { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; transform-origin: left; }
    .ok .bar, .approve .bar { background: #2fb36f; } .store .bar, .fill .bar, .reply .bar { background: #3b9bf0; }
    .warn .bar { background: #e39a3b; } .err .bar { background: #d93025; }
  `;

  let toastHost, toastBox, toastTheme = "auto";
  function toastRoot() {
    if (toastHost && toastHost.isConnected) return toastBox;
    toastHost = document.createElement("div");
    toastHost.id = "autonod-toasts";
    const root = toastHost.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${TOAST_CSS}</style><div class="box"></div>`;
    toastBox = root.querySelector(".box");
    document.documentElement.appendChild(toastHost);
    applyToastTheme();
    return toastBox;
  }
  function applyToastTheme() {
    if (!toastBox) return;
    const dark = toastTheme === "dark" || (toastTheme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
    toastBox.classList.toggle("dark", dark);
  }
  try {
    chrome.storage.local.get({ theme: "auto" }, ({ theme }) => { toastTheme = theme; applyToastTheme(); });
    chrome.storage.onChanged.addListener((c) => { if (c.theme) { toastTheme = c.theme.newValue || "auto"; applyToastTheme(); } });
  } catch (_) {}

  // toast({ kind, title, text, ms, group })
  //   kind:  ok | approve | store | fill | reply | warn | err  (colour + icon)
  //   group: toasts with the same group are merged into one card with a counter ("Approved · 3")
  function toast({ kind = "ok", title = "AutoNod", text = "", ms = 4000, group = "" } = {}) {
    if (window !== window.top) return;
    const box = toastRoot();

    let t = group && box.querySelector(`.t[data-group="${group}"]`);
    if (t) {
      t.count = (t.count || 1) + 1;
      t.querySelector(".ti").innerHTML = `${escHtml(title)}<small>&middot; ${t.count}</small>`;
      t.querySelector(".de").textContent = text;
      t.restart();
      return;
    }
    while (box.children.length >= 3) box.firstElementChild.remove(); // keep at most 3

    t = document.createElement("div");
    t.className = `t ${kind}`;
    if (group) t.dataset.group = group;
    t.innerHTML = `<span class="ic"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${TOAST_ICONS[kind] || TOAST_ICONS.ok}</svg></span>
      <div class="tx"><div class="ti">${escHtml(title)}</div><div class="de"></div></div>
      <button class="x" title="Close" aria-label="Close">&times;</button><div class="bar"></div>`;
    t.querySelector(".de").textContent = text;
    if (!text) t.querySelector(".de").remove();
    box.appendChild(t);

    const close = () => { t.classList.remove("in"); setTimeout(() => t.remove(), 200); };
    t.querySelector(".x").addEventListener("click", close);
    let anim, timer;
    t.restart = () => {
      if (!ms) return;
      clearTimeout(timer);
      anim?.cancel();
      anim = t.querySelector(".bar").animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: ms, fill: "forwards" });
      timer = setTimeout(close, ms);
    };
    // hovering keeps the card open
    t.addEventListener("mouseenter", () => { clearTimeout(timer); anim?.pause(); });
    t.addEventListener("mouseleave", () => {
      if (!ms || !anim) return;
      anim.play();
      timer = setTimeout(close, Math.max(400, ms - (anim.currentTime || 0)));
    });
    requestAnimationFrame(() => t.classList.add("in"));
    t.restart();
  }
  const escHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Turns a log line into a short, readable toast
  const TOAST_TITLES = { approve: "Approved", store: "Secure Store", fill: "Form filled", reply: "Sent in chat", error: "Needs your attention" };
  function toastText(type, detail) {
    let d = String(detail);
    if (type === "approve") {
      // 'Clicked "Allow" — Allow Muse to open fyple.com? Deny Allow' -> 'Allow Muse to open fyple.com?'
      d = d.split(" — ").slice(1).join(" — ") || d;
      const q = d.indexOf("?");
      if (q > 0) d = d.slice(0, q + 1);
    }
    return d.length > 110 ? d.slice(0, 110) + "…" : d;
  }

  function log(type, detail, showToast = true, extra = {}) {
    console.log("[AutoNod]", type, detail);
    if (showToast) {
      toast({
        kind: type === "error" ? "warn" : type,
        title: TOAST_TITLES[type] || "AutoNod",
        text: toastText(type, detail),
        group: type === "approve" ? "approve" : "",
      });
    }
    send({ type: "saveLog", kind: type, detail, host: location.host, ...extra });
  }

  // background.js does the actual saving, one write at a time (no lost entries)
  function send(msg) {
    if (!alive()) return;
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) { alive(); }
  }

  function saveCredential(email, password, where) {
    send({ type: "saveCred", email, password, where, host: location.host });
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- 1. auto approve ----------
  function findCard(btn, choices) {
    let node = btn.parentElement;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      const btns = choices.filter((b) => node.contains(b));
      if (btns.some((b) => DENY_RE.test(btnText(b)))) return { node, btns };
    }
    return null;
  }

  // OLD way (backup): find Allow/Deny buttons by their text. Used only if muse's card marker is missing.
  function legacyApprove() {
    const choices = findChoiceButtons();
    const waiting = new Set(); // risky cards (counted once each, even with 2 allow buttons)
    let clicked = false;
    for (const btn of choices) {
      const txt = btnText(btn);
      if (DENY_RE.test(txt)) continue;
      // skip if we clicked this in the last 4s (retry afterwards if the card is still there)
      if (Date.now() - Number(btn.dataset.museHelperClicked || 0) < 4000 || btn.disabled) continue;

      // Only act on real approval cards (Allow + Deny together)
      const card = findCard(btn, choices);
      if (!card) continue;

      // Money / deleting things: never auto-approve, ask the user (once per card)
      const cardText = (card.node.innerText || "").replace(/\s+/g, " ");
      const reason = waitReason(cardText);
      if (reason) {
        waiting.add(card.node);
        if (!btn.dataset.museHelperRisky) {
          card.btns.forEach((b) => (b.dataset.museHelperRisky = "1"));
          toast({ kind: "warn", title: "Waiting for you", text: `This card ${reason}. Please check it in Muse.`, ms: 9000 });
          log("error", `Skipped (needs your check): ${cardText.slice(0, 120)}`, false);
        }
        continue;
      }
      if (clicked) continue; // one click per tick, but keep counting risky cards

      const always = card.btns.find((b) => ALWAYS_RE.test(btnText(b)));
      const once = card.btns.find((b) => ALLOW_RE.test(btnText(b)));
      const target = (settings.preferAlways ? always || once : once || always) || btn;
      if (MONEY_RE.test(btnText(target))) { waiting.add(card.node); continue; } // e.g. "Confirm purchase"

      card.btns.forEach((b) => (b.dataset.museHelperClicked = String(Date.now())));
      const summary = (card.node.innerText || "").replace(/\s+/g, " ").slice(0, 140);
      setTimeout(() => {
        realClick(target);
        log("approve", `Clicked "${btnText(target)}" — ${summary}`);
      }, 300);
      clicked = true;
    }
    return waiting.size;
  }

  let legacyAt = 0, legacyWaiting = 0;
  function legacyApproveThrottled() {
    if (Date.now() - legacyAt < 10000) return legacyWaiting; // whole-page text scan: max every 10s
    legacyAt = Date.now();
    return (legacyWaiting = legacyApprove());
  }

  // NEW way: use muse's own card marker (much more reliable than reading text)
  // Idea credit: "Auto Approve for Muse" by homieyangg (MIT) - github.com/homieyangg/muse-auto-approve
  // includes cards in muse's right-hand "Needs review" panel (they have their own Allow / Deny buttons)
  const CARD_SEL = '[data-testid="hatch-inline-approval-card"]';
  const PRIMARY_SEL = '[data-hatch-approval-primary-action="true"]'; // muse's real "allow" button
  const SUB_SEL = '[role="button"][aria-expanded]'; // one item inside a card that asks for several things

  // Every approval on screen: a normal card, or each item of a combined card
  function museApprovals() {
    const out = [];
    for (const card of document.querySelectorAll(CARD_SEL)) {
      if (!visible(card)) continue;
      const items = [...card.querySelectorAll(SUB_SEL)].filter((i) => i.querySelector(PRIMARY_SEL));
      for (const node of items.length ? items : [card]) out.push(node);
    }
    return out;
  }

  // Only buttons that literally say Allow / Approve / Always allow are clicked.
  // If muse's main button says an action instead (e.g. "Send", "Post"), that can't be undone,
  // so it is returned as `action` and left for the user.
  function buttonsIn(node) {
    let always = null, once = null, action = null;
    for (const b of node.querySelectorAll('button, [role="button"]')) {
      if (b.matches(SUB_SEL) || !visible(b) || isDisabled(b)) continue;
      const t = btnText(b);
      if (DENY_RE.test(t)) continue;
      if (!always && ALWAYS_RE.test(t)) always = b;
      else if (!once && ALLOW_RE.test(t)) once = b;
      else if (!action && b.matches(PRIMARY_SEL)) action = b;
    }
    return { always, once, action };
  }

  const clicks = new Map(); // approval key -> { t, tries }
  const asked = new Set(); // cards we already told you about (survives React re-renders)
  const keyOf = (n, text) => n.getAttribute("data-autonod-id") || text.slice(0, 200);

  function askOnce(n, d) {
    const key = keyOf(n, d.text);
    if (asked.has(key)) return;
    asked.add(key);
    if (asked.size > 500) asked.clear();
    toast({ kind: "warn", title: "Waiting for you", text: `This card ${d.reason}. Please check it in Muse.`, ms: 9000 });
    log("error", `Skipped (needs your check): ${d.text.slice(0, 120)}`, false, { policy: d.policy });
  }

  // the real button: a split button's main part, never its ▾ menu arrow
  const pressable = (el) =>
    el.matches("button, [role='button']") ? el
      : el.querySelector("button:not([aria-haspopup]), [role='button']:not([aria-haspopup])") || el;

  function autoApprove() {
    document.dispatchEvent(new CustomEvent("autonod-mark")); // bridge.js refreshes ids / policies right now
    const approvals = museApprovals();
    if (!approvals.length) return reportWaiting(legacyApproveThrottled()); // marker missing -> old way

    // a click outside an open dialog can close it (e.g. Secure Store) - only act inside it
    const modal = [...document.querySelectorAll('[role="dialog"][aria-modal="true"], dialog[open]')].find(visible);
    let waiting = 0, pick = null;
    for (const n of approvals) {
      if (modal && !modal.contains(n)) continue;
      const d = decide(n);
      if (!d) continue;
      if (d.reason) { waiting++; askOnce(n, d); continue; }
      const key = keyOf(n, d.text);
      const c = clicks.get(key) || { t: 0, tries: 0 };
      if (Date.now() - c.t < 15000) continue; // clicked: give Muse 15s to answer
      if (c.tries >= 2) { waiting++; askOnce(n, { ...d, reason: "did not react to AutoNod's click" }); continue; }
      if (!pick) pick = { d, key, tries: c.tries + 1 };
    }
    reportWaiting(waiting);
    if (!pick) return;

    clicks.set(pick.key, { t: Date.now(), tries: pick.tries });
    if (clicks.size > 500) clicks.clear();
    const el = pressable(pick.d.target);
    realClick(el); // no setTimeout: in a hidden tab it could be held back up to a minute
    log("approve", `Clicked "${btnText(el)}" — ${pick.d.text.slice(0, 140)}`, true, { policy: pick.d.policy });
  }


  // ---------- 1b. Muse's "2 tasks need review  [Review]" bar ----------
  // Cards of background tasks only show after Review is pressed. When no card is on screen
  // but the bar is there, press Review. Same count again and still no card -> wait longer
  // (15s, 1m, 4m, 10m). Never while you are using the Muse tab yourself.
  const REVIEW_BAR_RE = /(\d+)\s*(tasks?|cards?|items?|approvals?)\s*needs?\s*(your\s*)?review/i;
  let reviewAt = 0, reviewSig = "", reviewGap = 15000, reviewWarned = false, lastInput = 0;
  for (const t of ["keydown", "pointerdown"])
    document.addEventListener(t, (e) => { if (e.isTrusted) lastInput = Date.now(); }, true);

  // find the bar by its text (cheap), then the Review button inside it
  function findReviewBar() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => (/review/i.test(t.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      for (let n = t.parentElement, i = 0; n && i < 5; n = n.parentElement, i++) {
        const txt = n.textContent || "";
        if (txt.length > 200) break;
        const m = txt.match(REVIEW_BAR_RE);
        if (!m) continue;
        const btn = [...n.querySelectorAll(CLICKABLE)].find((b) => /^review$/i.test(btnText(b)) && visible(b));
        if (btn) return { btn, count: m[1] };
      }
    }
    return null;
  }

  function openReviewPanel() {
    if (window !== window.top) return;
    const now = Date.now();
    if (now - reviewAt < reviewGap) return;
    if (!document.hidden && now - lastInput < 20000) return; // you're using Muse: don't move things
    if ([...document.querySelectorAll(CARD_SEL)].some(visible)) return; // cards already showing
    const bar = findReviewBar();
    if (!bar) { reviewSig = ""; reviewGap = 15000; return; }
    reviewGap = bar.count === reviewSig ? Math.min(reviewGap * 4, 600000) : 15000;
    if (reviewGap >= 240000 && !reviewWarned) {
      reviewWarned = true;
      log("error", "Pressed Review but no card AutoNod can read appeared — Muse's page may have changed", false);
    }
    reviewSig = bar.count;
    reviewAt = now;
    realClick(bar.btn);
    console.log("[AutoNod] pressed Review to show waiting task cards");
    toast({ kind: "ok", title: "Opened Review", text: "Showing Muse's waiting task cards.", ms: 2500, group: "review" });
  }


  // Tell background.js how many cards are waiting for the user -> red number on the toolbar icon
  let lastWaiting = -1;
  function reportWaiting(n) {
    if (window !== window.top || n === lastWaiting) return;
    lastWaiting = n;
    send({ type: "waiting", count: n });
  }

  // ---------- 2a. Muse "Secure Store" card -> Add -> fill dialog -> Enter ----------
  const SECURE_DIALOG_RE = /secure credentials|credentials store|enter password/i;
  const SECURE_CARD_RE = /secure store|sign in to/i;
  const recentPw = {}; // site -> { pw, t }
  let storeReady = false; // wait a moment after page load so the chat is fully rendered

  function ancestorMatching(el, re, levels) {
    let n = el.parentElement;
    for (let i = 0; i < levels && n; i++, n = n.parentElement) {
      if (re.test(n.textContent || "")) return n;
    }
    return null;
  }

  function secureAddButtons() {
    if (MUSE_OWN_PAGE_RE.test(location.pathname)) return [];
    return [...document.querySelectorAll(CLICKABLE)].filter((b) => {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim(); // cheap check first
      if (!/^(add|sign in|enter password)$/i.test(t)) return false;
      const card = ancestorMatching(b, SECURE_CARD_RE, 5);
      // "Sign in" also appears on connector cards (Google, Slack): require "Secure Store" for it
      return !!card && (/^add$/i.test(t) || /secure store/i.test(card.textContent || "")) && visible(b);
    });
  }


  // Password inputs: type="password", OR a text input that is clearly a password field
  // (Muse's "Create a password" field can be type="text" when the eye toggle shows it)
  function pwCandidates() {
    return [...document.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]):not([type="radio"])')].filter((i) => {
      if (i.type === "password" || i.dataset.museHelperStore) return true;
      const hints = `${i.placeholder || ""} ${i.name || ""} ${i.id || ""} ${i.autocomplete || ""} ${i.getAttribute("aria-label") || ""}`;
      if (/pass(word)?/i.test(hints)) return true;
      const label = i.parentElement && (i.parentElement.textContent || "").trim();
      return !!label && /^password/i.test(label);
    });
  }

  const secureDialogOpen = () =>
    pwCandidates().some((i) => visible(i) && ancestorMatching(i, SECURE_DIALOG_RE, 10));

  // Step 1: click "Add" on the NEWEST pending Secure Store card.
  // Completed cards change to "Added", so any card still showing "Add" is still waiting.
  // Each card element gets max 2 tries (2nd only if the first click didn't open the dialog).
  function clickSecureStoreAdd() {
    if (secureDialogOpen()) return false;
    const btns = secureAddButtons();
    const btn = btns[btns.length - 1]; // newest card is lowest in the chat
    if (!btn || btn.disabled) return false;

    const tries = Number(btn.dataset.museHelperAdd || 0);
    const lastTry = Number(btn.dataset.museHelperAddAt || 0);
    if (tries >= 2) {
      // Two clicks and no dialog: Muse is ignoring automated clicks here. Ask the user once.
      if (!btn.dataset.museHelperAsked && Date.now() - lastTry > 4000) {
        btn.dataset.museHelperAsked = "1";
        toast({ kind: "warn", title: "Please click “Add”", text: "Muse ignored the automatic click. Click Add on the Secure Store card — AutoNod fills email + password and presses Enter.", ms: 12000 });
        log("error", "Add click was ignored by Muse — asked you to click it", false);
      }
      return false;
    }
    if (tries === 1 && Date.now() - lastTry < 4000) return false; // give the dialog time to open

    const card = ancestorMatching(btn, SECURE_CARD_RE, 5);
    const ct = card.textContent || "";
    const site = (ct.match(/[Ss]ign in to\s*([a-z0-9.-]+?)(?=[A-Z]|\s|$)/) || [])[1] ||
      (ct.match(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?=[A-Z]|\s|$)/) || [])[0] || "site";

    btn.dataset.museHelperAdd = String(tries + 1);
    btn.dataset.museHelperAddAt = String(Date.now());
    setTimeout(() => {
      realClick(btn); // click FIRST, then log (logging can never block the click)
      log("store", tries ? `Retrying Add for ${site}` : `Opened Secure Store for ${site}`);
    }, 400);
    return true;
  }

  // Step 2: fill the "Secure credentials store" dialog and press Enter
  function fillSecureDialog() {
    for (const pwInput of pwCandidates()) {
      if (!visible(pwInput)) continue;
      // already filled by us and still showing our value -> the Enter retry loop is handling it
      if (pwInput.dataset.museHelperStore && pwInput.value) continue;
      const dialog =
        pwInput.closest('[role="dialog"], dialog, [aria-modal="true"]') || ancestorMatching(pwInput, SECURE_DIALOG_RE, 10);
      if (!dialog || !SECURE_DIALOG_RE.test(dialog.textContent || "")) continue;
      // Secure Store dialogs have a Website field; Muse's own password dialogs don't
      // (Website can be plain text now: textContent reads "Websitehttps://..." so no \b here)
      const hasWebsite = [...dialog.querySelectorAll("input")].some((i) => /^https?:\/\//.test(i.value)) ||
        /website|https?:\/\//i.test(dialog.textContent || "");
      if (!hasWebsite || MUSE_OWN_PAGE_RE.test(location.pathname)) continue;

      pwInput.dataset.museHelperStore = "1";
      pwInput.dataset.museHelperFilled = "1"; // keep the generic form filler away

      // Username / email field: always put YOUR email (Muse pre-fills things like "nick")
      for (const inp of dialog.querySelectorAll('input:not([type="password"]):not([type="checkbox"]):not([type="hidden"])')) {
        if (inp === pwInput || !visible(inp) || inp.disabled) continue;
        if (/^https?:\/\//.test(inp.value)) continue; // that's the Website field
        // Is this the Website field? (look at the label text near the input, not the whole dialog)
        let near = "", n = inp.parentElement;
        for (let i = 0; i < 2 && n && n !== dialog; i++, n = n.parentElement) near = n.textContent || "";
        const hints = `${near} ${inp.placeholder || ""} ${inp.name || ""} ${inp.id || ""} ${inp.getAttribute("aria-label") || ""}`;
        if (/website|url|site/i.test(hints) && !/user|email|login|name/i.test(hints)) continue;
        // Everything else in this dialog (Username / Email / "name" placeholder...) gets your email
        if (settings.email && inp.value !== settings.email) {
          if (inp.readOnly) inp.readOnly = false;
          typeLikeUser(inp, settings.email);
          inp.dataset.museHelperFilled = "1";
        }
      }

      const text = dialog.textContent || "";
      // "Websitehttps://www.site.comUsername..." -> stop the domain at the next capital letter
      const site = [...dialog.querySelectorAll("input")].map((i) => i.value).find((v) => /^https?:\/\//.test(v)) ||
        (text.match(/https?:\/\/[a-z0-9.-]+?(?=[A-Z]|\s|\/|$)/) || [])[0] || "secure store";

      // If Muse re-draws the same dialog, reuse the password we already made for this site
      const recent = recentPw[site];
      const pw = pwInput.value || (recent && Date.now() - recent.t < 120000 ? recent.pw : genPassword(settings.pwLength));
      recentPw[site] = { pw, t: Date.now() };
      if (!pwInput.value) typeLikeUser(pwInput, pw);
      const userVal =
        [...dialog.querySelectorAll('input:not([type="password"]):not([type="checkbox"])')]
          .filter((i) => i !== pwInput)
          .map((i) => i.value.trim())
          .find((v) => v && !/^https?:\/\//.test(v)) ||
        ((text.match(/Username\s*(.+?)\s*Password/) || [])[1]) ||
        settings.email;
      saveCredential(userVal, pw, `Secure Store · ${site}`);
      log("store", `Filled Secure Store for ${site} (${userVal})`);

      pressEnterWithRetry(dialog, pwInput, pw);
      return true;
    }
    return false;
  }

  // Type like a real user so React/other frameworks register the value
  function typeLikeUser(inp, value) {
    inp.focus();
    inp.select?.();
    let ok = false;
    try { ok = document.execCommand("insertText", false, value); } catch (_) {}
    if (!ok || inp.value !== value) setNativeValue(inp, value);
    inp.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  const isDisabled = (b) => b.disabled || b.getAttribute("aria-disabled") === "true";

  // Click Enter; if the dialog is still open, try again (up to 6 times), then fall back to the Enter key.
  // Refills always use the SAVED password `pw` (never a new one), and never form.requestSubmit():
  // on a form without a JS handler that navigates and puts the password in the URL.
  function pressEnterWithRetry(dialog, pwInput, pw, attempt = 1) {
    setTimeout(() => {
      if (!alive()) return;
      if (!dialog.isConnected || !visible(pwInput)) {
        if (attempt > 1) log("store", "Secure Store saved ✓");
        return;
      }
      for (const inp of dialog.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"])')) {
        if (!visible(inp) || inp.disabled || inp.value) continue;
        if (inp.type === "password" || inp === pwInput) typeLikeUser(inp, pw);
        else if (settings.email) typeLikeUser(inp, settings.email);
      }
      const enter = allButtons(dialog).find((b) => /^(enter|save|submit|continue|sign in|done|ok)$/i.test(btnText(b)));
      if (enter && !isDisabled(enter)) {
        realClick(enter);
        console.log("[AutoNod] pressed Enter in Secure Store, try", attempt);
      } else {
        const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        pwInput.dispatchEvent(new KeyboardEvent("keydown", o));
        pwInput.dispatchEvent(new KeyboardEvent("keyup", o));
      }
      if (attempt < 6) pressEnterWithRetry(dialog, pwInput, pw, attempt + 1);
      else log("error", "Secure Store dialog still open — please press Enter yourself");
    }, attempt === 1 ? 800 : 1200);
  }

  function secureStore() {
    if (fillSecureDialog()) return true; // works even if you click Add yourself
    return storeReady && clickSecureStoreAdd();
  }

  // muse.ai's own login / account pages: never touch them (could change YOUR Muse password)
  const MUSE_OWN_PAGE_RE = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|account|settings|profile|password|reset|billing)\b/i;
  // (v1.15: "Fill login forms" and "Reply in chat" were removed - your sites open in Muse's
  //  cloud browser, so those could only ever touch muse.ai itself)

  // ---------- main loop ----------
  let scheduled = false;
  function tick() {
    scheduled = false;
    if (!alive()) return;
    if (!settings.enabled) return reportWaiting(0);
    try {
      if (settings.autoApprove) {
        autoApprove();
        if (settings.openReview) openReviewPanel();
      }
      if (settings.secureStore) secureStore();
    } catch (e) {
      console.warn("[AutoNod]", e);
    }
  }
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      setTimeout(tick, 500);
    }
  };

  // only NEW elements can be new cards or bars (streamed text and our own toasts can't)
  function onMutations(list) {
    for (const m of list)
      for (const node of m.addedNodes)
        if (node.nodeType === 1 && node.id !== "autonod-toasts") return schedule();
  }

  chrome.storage.local.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    console.log("[AutoNod] running on", location.href, settings.enabled ? "(enabled)" : "(disabled)");
    // let the chat history finish loading so "newest card" really is the newest
    setTimeout(() => (storeReady = true), 3000);
    if (settings.enabled) {
      const lvl = settings.approveLevel || "standard";
      toast({ kind: "ok", title: "AutoNod is on", text: `${lvl[0].toUpperCase() + lvl.slice(1)} mode`, ms: 2500 });
    }
    observer = new MutationObserver(onMutations);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    timerId = setInterval(schedule, 2000);
    schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const k of Object.keys(DEFAULTS)) if (k in changes) settings[k] = changes[k].newValue;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    // background.js wakes us every 30s: Chrome slows our own timers to once a minute in hidden /
    // minimized tabs, but a message from the extension still runs right away
    if (!alive()) return;
    if (msg?.type === "tick") {
      tick();
      if (window === window.top) reply({ ok: true }); // answer once per tab (background re-injects if nobody answers)
      return;
    }
    if (window !== window.top) return;
    if (msg?.type === "ping") reply({ ok: true });
  });
})();
