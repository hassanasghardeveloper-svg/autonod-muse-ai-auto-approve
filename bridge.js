// AutoNod - page bridge (runs inside muse.ai's own JS world, "MAIN")
//
// The normal content script can't see React's internal data. This tiny script reads
// each approval card's real id + permission type from React and writes them onto the
// card as attributes, so content.js knows exactly which card is which.
//   data-autonod-id       -> muse's approval id (so one card is never clicked twice)
//   data-autonod-policy   -> permission type, e.g. "connector.gmail.users.messages.send"
//   data-autonod-scanned  -> "the bridge has looked at this card"
//
// No timers here: content.js fires "autonod-mark" right before it decides, and
// dispatchEvent runs synchronously - nothing for Chrome to slow down in a hidden tab.
//
// Idea credit: "Auto Approve for Muse" by homieyangg (MIT licence)
// https://github.com/homieyangg/muse-auto-approve
(() => {
  const VERSION = "1.15.0";
  if (window.__autonodBridge === VERSION) return;
  window.__autonodBridge = VERSION; // an older bridge keeps running harmlessly until the page reloads

  const CARD = '[data-testid="hatch-inline-approval-card"]';
  const ITEMS = `${CARD}, ${CARD} [role="button"][aria-expanded]`;
  const MAX_UP = 12; // how far up the React tree to look for approval data

  const fiberOf = (el) => {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    return key ? el[key] : null;
  };
  const isApproval = (v) => !!v && typeof v === "object" && typeof v.approvalId === "string";

  // Walk up from the element until a component has approval data in its props
  function approvalsOf(el) {
    for (let f = fiberOf(el), i = 0; f && i < MAX_UP; f = f.return, i++) {
      const props = f.memoizedProps;
      if (!props || typeof props !== "object") continue;
      for (const v of Object.values(props)) {
        if (isApproval(v)) return [v];
        if (Array.isArray(v) && v.length && v.every(isApproval)) return v;
      }
    }
    return [];
  }

  const setAttr = (el, name, value) => {
    if (!value) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };

  function mark() {
    if (window.__autonodBridge !== VERSION) return document.removeEventListener("autonod-mark", mark);
    try {
      for (const el of document.querySelectorAll(ITEMS)) {
        const list = approvalsOf(el);
        const one = list.length === 1 ? list[0] : null; // a card holding several approvals gets no id itself
        setAttr(el, "data-autonod-id", one?.approvalId);
        setAttr(el, "data-autonod-policy", one?.policySubject);
        setAttr(el, "data-autonod-scanned", "1");
      }
    } catch (e) {
      console.warn("[AutoNod] bridge", e);
    }
  }
  document.addEventListener("autonod-mark", mark);
  mark();

  // Debug helper: type __autonodDump() in the muse.ai DevTools console to see what React
  // knows about each card (look for a scheduled-task id, platform, account...)
  window.__autonodDump = () =>
    [...document.querySelectorAll(CARD)].map((el) => {
      const props = [];
      for (let f = fiberOf(el), i = 0; f && i < MAX_UP; f = f.return, i++)
        if (f.memoizedProps && typeof f.memoizedProps === "object") props.push(f.memoizedProps);
      return { text: el.innerText.slice(0, 120), props };
    });
})();
