// Light / dark theme for popup + dashboard.
// Choice is saved as "theme": "auto" (follow the computer) | "light" | "dark".
// A copy is kept in localStorage so the page gets the right colours before it even draws.
(() => {
  const root = document.documentElement;
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const MOON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"/></svg>';
  const SUN = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/></svg>';

  let pref = "auto";
  try { pref = localStorage.getItem("autonodTheme") || "auto"; } catch (_) {}

  function apply() {
    const dark = pref === "dark" || (pref === "auto" && mq.matches);
    root.dataset.theme = dark ? "dark" : "light";
    document.querySelectorAll("[data-theme-btn]").forEach((b) => {
      b.innerHTML = dark ? SUN : MOON;
      b.title = dark ? "Switch to light" : "Switch to dark";
      b.setAttribute("aria-label", b.title);
    });
    document.querySelectorAll("[data-theme-opt]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeOpt === pref)));
  }

  function remember(t) {
    pref = t || "auto";
    try { localStorage.setItem("autonodTheme", pref); } catch (_) {}
    apply();
  }

  apply();
  mq.addEventListener("change", apply);
  chrome.storage.local.get({ theme: "auto" }, ({ theme }) => remember(theme));
  chrome.storage.onChanged.addListener((c) => { if (c.theme) remember(c.theme.newValue); });

  document.addEventListener("DOMContentLoaded", () => {
    // header button: quick switch between light and dark
    document.querySelectorAll("[data-theme-btn]").forEach((b) =>
      b.addEventListener("click", () => chrome.storage.local.set({ theme: root.dataset.theme === "dark" ? "light" : "dark" }))
    );
    // settings: Auto / Light / Dark
    document.querySelectorAll("[data-theme-opt]").forEach((b) =>
      b.addEventListener("click", () => chrome.storage.local.set({ theme: b.dataset.themeOpt }))
    );
    apply();
  });
})();
