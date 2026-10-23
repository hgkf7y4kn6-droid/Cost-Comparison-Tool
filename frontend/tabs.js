// Top-level tab switching. Each sales-cycle stage is a tab; the URL hash
// (#today, #prospecting, #compare, …) selects one so tabs can be linked/bookmarked.
(function () {
  const buttons = Array.from(document.querySelectorAll(".tabs [role=tab]"));
  const names = buttons.map((b) => b.dataset.tab);
  const DEFAULT_TAB = "today";

  function showTab(name) {
    if (!names.includes(name)) name = DEFAULT_TAB;
    for (const b of buttons) {
      const active = b.dataset.tab === name;
      b.setAttribute("aria-selected", String(active));
      b.tabIndex = active ? 0 : -1;
      document.getElementById(`tab-${b.dataset.tab}`).hidden = !active;
    }
    if (location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
  }

  buttons.forEach((b, i) => {
    b.addEventListener("click", () => showTab(b.dataset.tab));
    b.addEventListener("keydown", (e) => {
      const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!step) return;
      const next = buttons[(i + step + buttons.length) % buttons.length];
      showTab(next.dataset.tab);
      next.focus();
    });
  });
  window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

  window.showTab = showTab;
  showTab(location.hash.slice(1));
})();
