// Expandable cards, modeled on DFS Riches' ExpandableCard: a header with the
// title, an optional subtitle and a short summary on the right ("aside"), and
// a chevron; clicking the header opens or closes the body. An optional
// .xcard-preview shows only while the card is collapsed.
//
// Markup:
//   <section class="xcard" data-card="unique-id" [data-open="false"]>
//     <div class="xcard-head">
//       <div class="xcard-titles"><h2>Title</h2><p class="xcard-sub">…</p></div>
//       <span class="xcard-aside"></span>
//     </div>
//     <div class="xcard-body">…</div>
//   </section>
//
// Each card's open/closed choice is remembered in this browser. Cards built
// later (e.g. on the Today tab) call SalesHub.cards.init(container).
(function () {
  const hub = window.SalesHub;
  const KEY = "ob.cards.v1";
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || "{}") || {};
  } catch (_) {
    saved = {};
  }

  function remember(id, open) {
    saved[id] = open;
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch (_) {
      // storage unavailable — the choice lasts for this page load
    }
  }

  function apply(card, open) {
    card.classList.toggle("collapsed", !open);
    const head = card.querySelector(":scope > .xcard-head");
    if (head) head.setAttribute("aria-expanded", String(open));
  }

  let uid = 0;
  function init(root = document) {
    for (const card of root.querySelectorAll(".xcard")) {
      if (card.dataset.ready) continue;
      card.dataset.ready = "1";
      const head = card.querySelector(":scope > .xcard-head");
      const body = card.querySelector(":scope > .xcard-body");
      if (!head || !body) continue;
      body.id = body.id || `xcard-body-${++uid}`;
      head.setAttribute("role", "button");
      head.tabIndex = 0;
      head.setAttribute("aria-controls", body.id);
      if (!head.querySelector(".xcard-chev")) {
        const chev = document.createElement("span");
        chev.className = "xcard-chev";
        chev.setAttribute("aria-hidden", "true");
        head.append(chev);
      }
      const id = card.dataset.card;
      const fallback = card.dataset.open !== "false";
      apply(card, id && id in saved ? saved[id] : fallback);
    }
  }

  function toggle(card, open) {
    const next = open ?? card.classList.contains("collapsed");
    apply(card, next);
    if (card.dataset.card) remember(card.dataset.card, next);
  }

  // One listener for every card, including ones added later.
  document.addEventListener("click", (e) => {
    const head = e.target.closest(".xcard-head");
    if (!head) return;
    // Controls inside the header (links, buttons, inputs) do their own thing.
    const control = e.target.closest("a, button, input, select, textarea, label");
    if (control && head.contains(control) && control !== head) return;
    toggle(head.parentElement);
  });
  document.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList && e.target.classList.contains("xcard-head")) {
      e.preventDefault();
      toggle(e.target.parentElement);
    }
  });

  hub.cards = {
    init,
    // Opens a card (e.g. before scrolling to it) and remembers that.
    open(el) {
      const card = el && el.closest(".xcard");
      if (card) toggle(card, true);
    },
  };
  init();
})();
