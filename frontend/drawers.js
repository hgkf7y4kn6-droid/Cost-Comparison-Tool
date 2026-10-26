// Lead, quote and account details open as side panels over the list instead
// of far down the page. Each tab still shows/hides its own panel (the `hidden`
// attribute); this watches those changes to show a backdrop, lock page
// scroll, move focus into the panel, and close it with Escape or a click
// outside. Closing goes through each panel's own Close button, so its checks
// (like unsaved quote changes) still apply.
(function () {
  const $ = (id) => document.getElementById(id);
  const DRAWERS = [
    ["lead-detail", "d-close"],
    ["quote-editor", "qe-close"],
    ["account-detail", "ad-close"],
  ];
  const backdrop = $("drawer-backdrop");
  let current = null;

  const isShown = (el) => !el.hidden && el.getClientRects().length > 0;

  function update() {
    const open = DRAWERS.find(([id]) => isShown($(id)));
    const id = open ? open[0] : null;
    backdrop.hidden = !id;
    document.body.classList.toggle("drawer-open", !!id);
    if (id && id !== current) {
      const el = $(id);
      el.scrollTop = 0;
      const heading = el.querySelector("h2");
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
    current = id;
  }

  function closeCurrent() {
    // A picker open inside the panel (the quote's item picker) closes first.
    const picker = current && $(current).querySelector(".picker:not([hidden])");
    if (picker) return picker.querySelector(".picker-back").click();
    const open = DRAWERS.find(([id]) => id === current);
    if (open) $(open[1]).click();
  }

  for (const [id, closeId] of DRAWERS) {
    const el = $(id);
    el.classList.add("drawer");
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    const x = document.createElement("button");
    x.type = "button";
    x.className = "drawer-close";
    x.setAttribute("aria-label", "Close panel");
    x.textContent = "×";
    x.addEventListener("click", () => $(closeId).click());
    el.prepend(x);
    new MutationObserver(update).observe(el, { attributes: true, attributeFilter: ["hidden"] });
  }
  // Switching tabs hides the panel's parent, so watch the tab panels too.
  for (const panel of document.querySelectorAll(".tab-panel")) {
    new MutationObserver(update).observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  }

  backdrop.addEventListener("click", closeCurrent);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current && $("signin").hidden) closeCurrent();
  });
  update();
})();
