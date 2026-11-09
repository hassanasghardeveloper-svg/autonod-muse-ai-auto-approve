// AutoNod - content script
(() => {
  // Can be injected twice (manifest + background re-inject) - run only one copy per page
  if (window.__museAutoHelper) return;
  window.__museAutoHelper = true;

  const DEFAULTS = {
    enabled: true,
    autoApprove: true,
    preferAlways: true,
    approveLevel: "standard", // safe | standard | autopilot (set by the mode)
    autoFillForms: false,
    chatReply: false,
    secureStore: true,
    email: "",
    pwLength: 16,
  };

  // Matches e.g. "Allow", "Allow once", "Always allow uploads to this site", "Deny"
  const ALLOW_RE = /^(allow|approve|accept|confirm)\b/i;
  const ALWAYS_RE = /^(always allow|allow always|always approve)\b/i;
  const DENY_RE = /^(deny|reject|decline|don'?t\b|do not\b|block)/i;
  const ASK_CREDS_RE = /(e-?mail|username)[\s\S]{0,200}password|password[\s\S]{0,200}(e-?mail|username)/i;
  // Permission types (from bridge.js) that must never be auto-approved
  // ---- what waits for the user depends on the mode (approveLevel) ----
  // Money: waits in EVERY mode
  const MONEY_RE = /\b(pay|payment|purchase|buy|checkout|place (an |the )?order|subscribe|subscription|billing|credit card|card number|transfer|send money|donat\w*)\b/i;
  const MONEY_POLICY_RE = /(purchase|payment|checkout|billing|order)/i;
  // Deleting: waits in Safe; in Standard only when it is the real action (not a list like "create, edit ... and delete")
  const DELETE_RE = /\b(delete|remove|erase|wipe|uninstall|cancel (my|the|your) (account|subscription))\b/i;
  const DELETE_POLICY_RE = /[._](delete|trash|remove)\b/i;
  const BUNDLE_RE = /\b(create|edit|schedule|publish|post|upload|manage|update|read|view)\b/i;
  // Posting / messaging: waits in Safe only
  const ACTION_RE = /\b(post|posts|publish|send|message|messages|email|comment|reply|share|tweet|upload)\b/i;

  // Only the card's question is checked (not long descriptions / captions)
  const questionOf = (text) => {
    const i = text.indexOf("?");
    return (i > 0 && i < 400 ? text.slice(0, i + 1) : text.slice(0, 300));
  };

  // Returns why a card must wait for the user, or "" if AutoNod may click it
  function waitReason(text, policy, actionLabel) {
    const q = questionOf(text);
    const level = settings.approveLevel || "standard";
    const money = q.match(MONEY_RE) || policy.match(MONEY_POLICY_RE);
    if (money) return `mentions "${money[0]}"`;
    if (level === "autopilot") return "";
    if (actionLabel) return `wants to "${actionLabel}"`;
    const del = q.match(DELETE_RE);
    if (policy.match(DELETE_POLICY_RE)) return "is a delete";
    if (level === "safe") {
      if (del) return `mentions "${del[0]}"`;
      const act = q.match(ACTION_RE);
      if (act) return `mentions "${act[0]}"`;
      return "";
    }
    if (del && !BUNDLE_RE.test(q)) return `mentions "${del[0]}"`; // standard
    return "";
  }
  // Cards about money or deleting things are left for the user
  const RISKY_RE = /\b(pay|payment|purchase|buy|checkout|place (an |the )?order|subscribe|subscription|billing|credit card|card number|transfer|send money|donat\w*|delete|remove|erase|wipe|uninstall|cancel (my|the|your) (account|subscription))\b/i;
  const ASK_VERB_RE = /(provide|share|enter|send|give|need|what|which|tell|type|sign ?up|log ?in|create)/i;

  let settings = { ...DEFAULTS };
  const handledTexts = new Set();
  let lastReplyAt = 0;

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
  let dead = false;
  function alive() {
    if (dead) return false;
    try {
      if (chrome.runtime?.id) return true;
    } catch (_) {}
    dead = true; // a fresh copy is injected by background.js, so just step aside quietly
    console.log("[AutoNod] old copy stopped (extension was reloaded)");
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

  function log(type, detail, showToast = true) {
    console.log("[AutoNod]", type, detail);
    if (showToast) {
      toast({
        kind: type === "error" ? "warn" : type,
        title: TOAST_TITLES[type] || "AutoNod",
        text: toastText(type, detail),
        group: type === "approve" ? "approve" : "",
      });
    }
    send({ type: "saveLog", kind: type, detail, host: location.host });
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
      const reason = waitReason(cardText, "", "");
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

  // NEW way: use muse's own card marker (much more reliable than reading text)
  // Idea credit: "Auto Approve for Muse" by homieyangg (MIT) - github.com/homieyangg/muse-auto-approve
  // includes cards in muse's right-hand "Needs review" panel (they have their own Allow / Deny buttons)
  const CARD_SEL = '[data-testid="hatch-inline-approval-card"]';
  const PRIMARY_SEL = '[data-hatch-approval-primary-action="true"]'; // muse's real "allow" button
  const SUB_SEL = '[role="button"][aria-expanded]'; // one item inside a card that asks for several things
  const clickedAt = new Map(); // approval id (or card text) -> last click time

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

  function autoApprove() {
    const approvals = museApprovals();
    if (!approvals.length) return reportWaiting(legacyApprove()); // marker missing -> old way

    let waiting = 0, target = null, node = null;
    for (const n of approvals) {
      const { always, once, action } = buttonsIn(n);
      if (!always && !once && !action) continue;
      const text = (n.innerText || "").replace(/\s+/g, " ");
      const policy = n.getAttribute("data-autonod-policy") || "";

      // Depending on the mode, some cards wait for the user. Count them for the red badge and tell the user once.
      const isAction = !always && !once; // the main button is an action, e.g. "Send", "Post"
      const reason = waitReason(text, policy, isAction ? btnText(action) : "");
      if (reason) {
        waiting++;
        if (!n.dataset.autonodAsked) {
          n.dataset.autonodAsked = "1";
          toast({ kind: "warn", title: "Waiting for you", text: `This card ${reason}. Please check it in Muse.`, ms: 9000 });
          log("error", `Skipped (needs your check): ${text.slice(0, 120)}`, false);
        }
        continue;
      }

      // Never click the same card twice within 5 seconds
      const key = n.getAttribute("data-autonod-id") || text.slice(0, 200);
      if (Date.now() - (clickedAt.get(key) || 0) < 5000) continue;
      if (!target) {
        target = (settings.preferAlways ? always || once : once || always) || action; // action only in Autopilot
        node = n;
        clickedAt.set(key, Date.now());
      }
    }
    reportWaiting(waiting);
    if (!target) return;

    const summary = (node.innerText || "").replace(/\s+/g, " ").slice(0, 140);
    setTimeout(() => {
      realClick(target);
      log("approve", `Clicked "${btnText(target)}" — ${summary}`);
    }, 300);
    if (clickedAt.size > 500) clickedAt.clear(); // keep memory small
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
    return allButtons().filter(
      (btn) => /^(add|sign in|enter password)$/i.test(btnText(btn)) && ancestorMatching(btn, SECURE_CARD_RE, 5)
    );
  }

  const secureDialogOpen = () =>
    [...document.querySelectorAll('input[type="password"]')].some(
      (i) => visible(i) && ancestorMatching(i, SECURE_DIALOG_RE, 10)
    );

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
    for (const pwInput of document.querySelectorAll('input[type="password"], input[data-muse-helper-store]')) {
      if (!visible(pwInput)) continue;
      // already filled by us and still showing our value -> the Enter retry loop is handling it
      if (pwInput.dataset.museHelperStore && pwInput.value) continue;
      const dialog =
        pwInput.closest('[role="dialog"], dialog, [aria-modal="true"]') || ancestorMatching(pwInput, SECURE_DIALOG_RE, 10);
      if (!dialog || !SECURE_DIALOG_RE.test(dialog.textContent || "")) continue;

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
          .map((i) => i.value.trim())
          .find((v) => v && !/^https?:\/\//.test(v)) ||
        ((text.match(/Username\s*(.+?)\s*Password/) || [])[1]) ||
        settings.email;
      saveCredential(userVal, pw, `Secure Store · ${site}`);
      log("store", `Filled Secure Store for ${site} (${userVal})`);

      pressEnterWithRetry(dialog, pwInput);
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

  // Click Enter; if the dialog is still open, try again (up to 6 times), then fall back to the Enter key
  function pressEnterWithRetry(dialog, pwInput, attempt = 1) {
    setTimeout(() => {
      if (!dialog.isConnected || !visible(pwInput)) {
        if (attempt > 1) log("store", "Secure Store saved ✓");
        return;
      }
      // never press Enter with an empty field (Muse shows "Please fill out this field")
      for (const inp of dialog.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"])')) {
        if (!visible(inp) || inp.disabled || inp.value) continue;
        if (inp.type === "password") typeLikeUser(inp, pwInput.value || genPassword(settings.pwLength));
        else if (settings.email) typeLikeUser(inp, settings.email);
      }
      const enter = allButtons(dialog).find((b) => /^(enter|save|submit|continue|sign in|done|ok)$/i.test(btnText(b)));
      if (enter && !isDisabled(enter)) {
        realClick(enter);
        log("store", `Pressed Enter in Secure Store (try ${attempt})`);
      } else {
        // button missing/disabled: re-type the password and hit the Enter key in the field
        const v = pwInput.value;
        if (v) typeLikeUser(pwInput, v);
        const o = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
        pwInput.dispatchEvent(new KeyboardEvent("keydown", o));
        pwInput.dispatchEvent(new KeyboardEvent("keyup", o));
        pwInput.form?.requestSubmit?.();
      }
      if (attempt < 6) pressEnterWithRetry(dialog, pwInput, attempt + 1);
      else if (dialog.isConnected && visible(pwInput)) log("error", "Secure Store dialog still open — please press Enter yourself");
    }, attempt === 1 ? 800 : 1200);
  }

  function secureStore() {
    if (fillSecureDialog()) return true; // works even if you click Add yourself
    return storeReady && clickSecureStoreAdd();
  }

  // ---------- 2b. fill login / signup forms ----------
  // muse.ai's own login / account pages: never touch them (could change YOUR Muse password)
  const MUSE_OWN_PAGE_RE = /\/(login|log-in|signin|sign-in|signup|sign-up|register|auth|account|settings|profile|password|reset|billing)\b/i;
  const ownMuseField = (i) =>
    /^(current-password|new-password)$/i.test(i.autocomplete || "") && !i.closest('[role="dialog"], dialog, [aria-modal="true"]');

  function autoFillForms() {
    if (!settings.email) return;
    if (window === window.top && MUSE_OWN_PAGE_RE.test(location.pathname)) return;
    const inSecureDialog = (i) => !!ancestorMatching(i, SECURE_DIALOG_RE, 10);
    const pwFields = [...document.querySelectorAll('input[type="password"]')].filter(
      (i) => visible(i) && !i.value && !i.dataset.museHelperFilled && !ownMuseField(i) && !(settings.secureStore && inSecureDialog(i))
    );
    const emailFields = [
      ...document.querySelectorAll(
        'input[type="email"], input[autocomplete="email"], input[autocomplete="username"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]'
      ),
    ].filter((i) => visible(i) && !i.value && !i.dataset.museHelperFilled && !(settings.secureStore && inSecureDialog(i)));

    if (!pwFields.length && !emailFields.length) return;

    emailFields.forEach((i) => {
      setNativeValue(i, settings.email);
      i.dataset.museHelperFilled = "1";
    });

    if (pwFields.length) {
      const pw = genPassword(settings.pwLength);
      pwFields.forEach((i) => {
        setNativeValue(i, pw); // same password in "confirm password" too
        i.dataset.museHelperFilled = "1";
      });
      saveCredential(settings.email, pw, "form");
      log("fill", `Filled form with ${settings.email} + generated password`);
    }
  }

  // ---------- 3. reply in chat when Muse asks for email + password ----------
  function findComposer() {
    const c = [...document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]')].filter(visible);
    return c[c.length - 1] || null;
  }

  function latestCredentialRequest() {
    const composer = findComposer();
    const blocks = [...document.querySelectorAll("p, li, div, span")].filter((el) => {
      if (composer && (composer === el || composer.contains(el) || el.contains(composer))) return false;
      const t = el.innerText || "";
      if (t.length > 1500 || !ASK_CREDS_RE.test(t) || !ASK_VERB_RE.test(t)) return false;
      if (settings.email && t.includes(settings.email)) return false; // our own reply
      return true;
    });
    // keep the innermost matches, take the last one on the page
    const leaves = blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o)));
    return leaves[leaves.length - 1] || null;
  }

  function typeIntoComposer(el, text) {
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      setNativeValue(el, text);
    } else {
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
    }
  }

  function pressSend(composer) {
    const scope = composer.closest("form") || composer.parentElement?.parentElement?.parentElement || document;
    const send = allButtons(scope).find((b) => /send|submit/i.test(b.getAttribute("aria-label") || "") || /^send$/i.test(btnText(b))) ||
      scope.querySelector('button[type="submit"]');
    if (send && !send.disabled) return send.click();
    const opts = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true };
    composer.dispatchEvent(new KeyboardEvent("keydown", opts));
    composer.dispatchEvent(new KeyboardEvent("keypress", opts));
    composer.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function sendCredentials(manual = false) {
    if (!settings.email) {
      log("error", "No email set — open the extension popup and save your email.");
      return false;
    }
    const composer = findComposer();
    if (!composer) return false;
    const pw = genPassword(settings.pwLength);
    const msg = `Email: ${settings.email}\nPassword: ${pw}`;
    typeIntoComposer(composer, msg);
    setTimeout(() => pressSend(composer), 400);
    saveCredential(settings.email, pw, manual ? "chat (manual)" : "chat");
    log("reply", `Sent ${settings.email} + generated password in chat`);
    lastReplyAt = Date.now();
    return true;
  }

  function autoReplyChat() {
    if (Date.now() - lastReplyAt < 20000) return;
    const req = latestCredentialRequest();
    if (!req) return;
    const key = (req.innerText || "").trim().slice(0, 300);
    if (handledTexts.has(key)) return;
    handledTexts.add(key);
    // Wait a moment so Muse finishes streaming its message
    setTimeout(() => sendCredentials(false), 1500);
  }

  // ---------- main loop ----------
  let scheduled = false;
  function tick() {
    scheduled = false;
    if (!alive()) return;
    if (!settings.enabled) return reportWaiting(0);
    try {
      if (settings.autoApprove) autoApprove();
      const storeBusy = settings.secureStore && secureStore();
      if (settings.autoFillForms) autoFillForms();
      if (settings.chatReply && !storeBusy) autoReplyChat();
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

  chrome.storage.local.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    console.log("[AutoNod] running on", location.href, settings.enabled ? "(enabled)" : "(disabled)");
    // Don't auto-reply to requests that were already on the page before load
    const existing = latestCredentialRequest();
    if (existing) handledTexts.add((existing.innerText || "").trim().slice(0, 300));
    // let the chat history finish loading so "newest card" really is the newest
    setTimeout(() => (storeReady = true), 3000);
    if (settings.enabled) {
      const lvl = settings.approveLevel || "standard";
      toast({ kind: "ok", title: "AutoNod is on", text: `${lvl[0].toUpperCase() + lvl.slice(1)} mode`, ms: 2500 });
    }
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(schedule, 2000);
    schedule();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const k of Object.keys(DEFAULTS)) if (k in changes) settings[k] = changes[k].newValue;
  });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (window !== window.top) return;
    if (msg?.type === "ping") reply({ ok: true });
    if (msg?.type === "sendCredentials") reply({ ok: sendCredentials(true) });
  });
})();
