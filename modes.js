// Shared by popup + dashboard: 3 simple modes instead of many switches.
// A mode just sets the main switches; "Custom" = the switches were changed by hand.
const MODES = {
  safe: {
    label: "Safe",
    desc: "Approves website cards only. Posts, messages and deletes wait for you. You type logins yourself.",
    set: { autoApprove: true, approveLevel: "safe", secureStore: false, autoFillForms: false },
  },
  standard: {
    label: "Standard",
    desc: "Approves cards (also post permissions) and fills Secure Store with your email + a strong password. Single deletes and Send/Post buttons wait for you.",
    set: { autoApprove: true, approveLevel: "standard", secureStore: true, autoFillForms: false },
  },
  autopilot: {
    label: "Autopilot",
    desc: "Approves everything - posts, sends and deletes too - and fills login forms.",
    set: { autoApprove: true, approveLevel: "autopilot", secureStore: true, autoFillForms: true },
  },
};
const ALWAYS_NOTE = "Payment cards always wait for you.";

function modeOf(s) {
  for (const [key, m] of Object.entries(MODES)) {
    if (Object.entries(m.set).every(([k, v]) => (typeof v === "boolean" ? !!s[k] === v : (s[k] || "standard") === v))) return key;
  }
  return "custom";
}

// Wires a .seg container (buttons with data-mode) + a description element
function setupModes(segEl, descEl) {
  segEl.querySelectorAll("button[data-mode]").forEach((b) =>
    b.addEventListener("click", () => chrome.storage.local.set(MODES[b.dataset.mode].set))
  );
  return (s) => {
    const mode = modeOf(s);
    segEl.querySelectorAll("button[data-mode]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
    descEl.textContent =
      mode === "custom" ? "Custom settings (changed by hand in Advanced). Pick a mode to reset." : `${MODES[mode].desc} ${ALWAYS_NOTE}`;
  };
}
