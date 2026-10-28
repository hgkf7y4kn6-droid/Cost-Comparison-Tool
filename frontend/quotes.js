// Proposals & Quotes tab: build quotes for qualified leads / accounts, pull in
// good/better/best lines from the Cost Comparison tab, show savings vs. the
// customer's current pricing, print a proposal, and track sent → won/lost.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money, esc, calc } = hub;

  const STATUSES = {
    draft: "Draft",
    sent: "Sent",
    negotiating: "Negotiating",
    won: "Won",
    lost: "Lost",
  };
  const OPEN_STATUSES = ["draft", "sent", "negotiating"];

  const FREQS = calc.FREQS;

  const LINE_TYPES = {
    janitorial: "Janitorial & facility",
    furniture: "Furniture & design",
    apparel: "Uniforms & apparel",
    other: "Other",
  };

  const LOSS_REASONS = ["Price", "Incumbent contract", "No decision", "Timing / budget", "Went with competitor", "Other"];

  const LINE_KEYWORDS = {
    furniture: /\b(chair|desk|table|workstation|cabinet|shelv|cubicle|seating|furniture|bookcase|credenza|ergonomic)/,
    apparel: /\b(shirt|polo|scrub|jacket|uniform|apparel|hat|cap|vest|pant|quarter[- ]?zip|hoodie|fleece)/,
  };

  function guessLineType(text) {
    const t = (text || "").toLowerCase();
    if (LINE_KEYWORDS.furniture.test(t)) return "furniture";
    if (LINE_KEYWORDS.apparel.test(t)) return "apparel";
    return "janitorial";
  }

  const DEFAULT_FREQ = { janitorial: "month", furniture: "once", apparel: "once", other: "once" };

  // Default sales-tax rate from the customer's location. Reps confirm per deal.
  function defaultTaxRate(c) {
    const st = (c.state || "").toUpperCase();
    const county = (c.county || "").toLowerCase().replace(/\s+county$/, "");
    const city = (c.city || "").toLowerCase();
    if (st === "NJ" || c.region === "nj") return 6.625;
    if ((st === "PA" || !st) && (county === "philadelphia" || city === "philadelphia")) return 8;
    if (st === "PA" || ["philadelphia", "lehigh", "lancaster"].includes(c.region)) return 6;
    return 0;
  }

  // --- Math -----------------------------------------------------------------

  // All arithmetic lives in calc.js (shared with the order tab and unit-tested).
  const { num, hasValue, lineMargin } = calc;
  const totals = calc.quoteTotals;
  const pct = (n) => `${n.toFixed(1)}%`;
  const DEFAULT_TARGET_MARGIN = 30;
  const targetMarginPct = () => num((state.settings || {}).targetMargin ?? DEFAULT_TARGET_MARGIN);
  const MARGIN_RULE = "Margin must be at least 0% and below 100%.";

  // Validity counts from the day it was sent (or created), on the rep's local calendar.
  const validUntil = (q) => hub.addDays(calc.toLocalDate(q.sentDate || q.created) || hub.today(), q.validDays || 30);
  const isExpired = (q) => ["sent", "negotiating"].includes(q.status) && hub.today() > validUntil(q);

  // --- Customers (leads + accounts) ------------------------------------------

  const findLead = (id) => state.leads.find((l) => l.id === id);
  const findAccount = (id) => state.accounts.find((a) => a.id === id);

  function customerFor(q) {
    return (q.accountId && findAccount(q.accountId)) || (q.leadId && findLead(q.leadId)) || null;
  }

  function fillCustomerSelect(select, current) {
    select.replaceChildren(new Option("— Choose a qualified lead or account —", ""));
    const accounts = [...state.accounts].sort((a, b) => a.company.localeCompare(b.company));
    const leads = state.leads
      .filter((l) => ["qualified", "proposal", "won", "contacted"].includes(l.stage) || `lead:${l.id}` === current)
      .sort((a, b) => a.company.localeCompare(b.company));
    if (accounts.length) {
      const g = document.createElement("optgroup");
      g.label = "Accounts";
      for (const a of accounts) g.append(new Option(a.company, `account:${a.id}`));
      select.append(g);
    }
    if (leads.length) {
      const g = document.createElement("optgroup");
      g.label = "Leads (contacted / qualified)";
      for (const l of leads) g.append(new Option(`${l.company} — ${hub.ref.STAGES[l.stage]}`, `lead:${l.id}`));
      select.append(g);
    }
    select.value = current || "";
  }

  // --- Create ---------------------------------------------------------------

  function newQuote(customer) {
    const now = new Date().toISOString();
    const q = {
      id: hub.newId("Q"),
      number: hub.nextNumber("quote", "Q"),
      leadId: null,
      accountId: null,
      company: "",
      contactName: "",
      contactTitle: "",
      email: "",
      status: "draft",
      created: now,
      updated: now,
      validDays: 30,
      terms: "Net 30",
      delivery: 0,
      discountPct: 0,
      taxRate: 0,
      taxExempt: false,
      notes: "",
      lossReason: "",
      lines: [],
    };
    if (customer) applyCustomer(q, customer.kind, customer.record);
    state.quotes.push(q);
    return q;
  }

  function applyCustomer(q, kind, rec) {
    q.leadId = kind === "lead" ? rec.id : rec.leadId || null;
    q.accountId = kind === "account" ? rec.id : null;
    if (kind === "lead") {
      const acct = state.accounts.find((a) => a.leadId === rec.id);
      if (acct) q.accountId = acct.id;
    }
    q.company = rec.company || "";
    q.contactName = rec.contactName || "";
    q.contactTitle = rec.contactTitle || "";
    q.email = rec.email || "";
    q.taxRate = defaultTaxRate(rec);
  }

  function lineFromComparison(c, tier) {
    const item = c.tiers && c.tiers[tier];
    if (!item) return null;
    const type = guessLineType(`${c.matched_category || ""} ${item.name || ""} ${item.description || ""}`);
    // When both sides know uses-per-case, compare cost-per-use scaled to our case
    // size; otherwise it's a case-for-case substitution.
    let current = c.competitor_price ?? "";
    if (c.competitor_cost_per_use && item.uses_per_case) current = calc.round2(c.competitor_cost_per_use * item.uses_per_case);
    const known = hub.catalog.bySku(item.sku);
    return {
      category: known ? known.cat : hub.catalog.categorize(c.matched_category, item.name),
      id: hub.newId("ln"),
      sku: item.sku || "",
      name: item.name || "",
      type,
      tier,
      qty: 1,
      uom: "case",
      freq: DEFAULT_FREQ[type],
      unitPrice: num(item.price),
      currentPrice: current,
      cost: known ? known.cost : "",
      taxable: type !== "apparel",
      replaces: c.competitor_product || "",
    };
  }

  // --- List -----------------------------------------------------------------

  let openId = null;
  let draft = null; // working copy of the open quote
  let dirty = false;

  fillSelect($("q-f-status"), STATUSES, true);

  function fillSelect(select, options, keepFirst) {
    const first = keepFirst ? select.options[0] : null;
    select.replaceChildren(...(first ? [first] : []));
    for (const [v, label] of Object.entries(options)) select.append(new Option(label, v));
  }

  function filteredQuotes() {
    const q = $("q-f-search").value.trim().toLowerCase();
    const status = $("q-f-status").value;
    return state.quotes
      .filter((x) =>
        (!status || (status === "expired" ? isExpired(x) : x.status === status)) &&
        (!q || [x.number, x.company, x.contactName].some((v) => (v || "").toLowerCase().includes(q))))
      .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
  }

  function statusBadge(q) {
    const span = document.createElement("span");
    const expired = isExpired(q);
    span.className = `stage qs-${expired ? "expired" : q.status}`;
    span.textContent = expired ? "Expired" : STATUSES[q.status];
    return span;
  }

  function renderKpis() {
    const open = state.quotes.filter((q) => OPEN_STATUSES.includes(q.status) && !isExpired(q));
    const won = state.quotes.filter((q) => q.status === "won");
    const lost = state.quotes.filter((q) => q.status === "lost");
    const sum = (list, k) => list.reduce((s, q) => s + totals(q)[k], 0);
    const closeDays = won.filter((q) => q.sentDate && q.decidedDate)
      .map((q) => (new Date(q.decidedDate) - new Date(q.sentDate)) / 86400000);
    const tiles = [
      ["Open pipeline", money(sum(open, "firstYear")), `${open.length} open quote${open.length === 1 ? "" : "s"} · first-year value`],
      ["Won — annual recurring", money(sum(won, "recurring")), `${won.length} won · ${money(sum(won, "oneTime"))} one-time`],
      ["Win rate", won.length + lost.length ? `${Math.round((won.length / (won.length + lost.length)) * 100)}%` : "—", `${won.length} won / ${lost.length} lost`],
      ["Avg. days to close", closeDays.length ? Math.round(closeDays.reduce((a, b) => a + b, 0) / closeDays.length) : "—", "sent → won"],
      ["Margin — open quotes", blendedMargin(open), `won: ${blendedMargin(won)} · target ${pct(targetMarginPct())}`],
    ];
    renderTiles($("q-kpis"), tiles);
  }

  function blendedMargin(list) {
    let rev = 0, profit = 0;
    for (const q of list) {
      const t = totals(q);
      rev += t.costedRevenue;
      profit += t.grossProfit;
    }
    return rev > 0 ? pct((profit / rev) * 100) : "—";
  }

  function renderTiles(container, tiles) {
    container.replaceChildren();
    for (const [label, value, sub] of tiles) {
      const div = document.createElement("div");
      div.className = "kpi";
      div.innerHTML = `<span class="muted"></span><strong></strong><small class="muted"></small>`;
      div.children[0].textContent = label;
      div.children[1].textContent = value;
      div.children[2].textContent = sub;
      container.append(div);
    }
  }
  hub.renderTiles = renderTiles;

  function renderList() {
    const list = filteredQuotes();
    const tbody = $("q-rows");
    tbody.replaceChildren();
    for (const q of list) {
      const t = totals(q);
      const tr = document.createElement("tr");
      tr.dataset.id = q.id;
      tr.tabIndex = 0;
      if (q.id === openId) tr.className = "selected";
      const cells = [
        q.number,
        q.company || "(no customer)",
        null,
        String(q.lines.length),
        money(t.orderTotal),
        money(t.firstYear),
        t.savings ? money(t.savings) : "—",
        t.marginPct === null ? "—" : pct(t.marginPct) + (t.missingCost ? "*" : ""),
        hub.fmtDate(validUntil(q)),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i === 2) td.append(statusBadge(q));
        else td.textContent = text;
        if (i >= 3 && i <= 7) td.className = "num";
        if (i === 7 && t.marginPct !== null && t.marginPct < targetMarginPct()) td.className = "num warn";
        if (i === 7 && t.missingCost) td.title = `Cost missing on ${t.missingCost} line(s)`;
        tr.append(td);
      });
      tbody.append(tr);
    }
    $("q-count").textContent = `${list.length} of ${state.quotes.length} quotes`;
    $("q-empty").hidden = state.quotes.length > 0;
  }

  function renderAll() {
    renderKpis();
    renderList();
  }

  ["q-f-search", "q-f-status"].forEach((id) => $(id).addEventListener("input", renderList));
  $("q-rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openQuote(tr.dataset.id);
  });
  $("q-rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openQuote(tr.dataset.id);
    }
  });

  $("q-new").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    dirty = false;
    const lead = findLead(state.activeLeadId);
    const q = newQuote(lead ? { kind: "lead", record: lead } : null);
    hub.save();
    openQuote(q.id);
  });

  $("q-export").addEventListener("click", () => {
    const rows = [];
    for (const q of filteredQuotes()) {
      const t = totals(q);
      for (const l of q.lines.length ? q.lines : [{}]) {
        rows.push([q.number, q.company, STATUSES[q.status], isExpired(q) ? "yes" : "", calc.toLocalDate(q.created),
          q.sentDate || "", q.decidedDate || "", l.sku, l.name, LINE_TYPES[l.type] || "", l.tier, l.qty, l.uom,
          FREQS[l.freq] ? FREQS[l.freq].label : "", l.unitPrice, l.currentPrice, l.cost ?? "",
          l.unitPrice !== undefined && lineMargin(l, 1 - num(q.discountPct) / 100) !== null
            ? lineMargin(l, 1 - num(q.discountPct) / 100).toFixed(1) : "",
          t.orderTotal.toFixed(2), t.recurring.toFixed(2), t.oneTime.toFixed(2), t.savings.toFixed(2),
          t.marginPct === null ? "" : t.marginPct.toFixed(1), t.grossProfit.toFixed(2), q.lossReason]);
      }
    }
    hub.downloadCsv(`quotes-INTERNAL-costs-and-margins-${hub.today()}.csv`,
      ["quote", "company", "status", "expired", "created", "sent", "decided", "sku", "description", "product_line",
        "tier", "qty", "uom", "frequency", "unit_price", "current_price", "unit_cost", "line_margin_pct",
        "order_total", "annual_recurring", "one_time", "annual_savings", "quote_margin_pct", "gross_profit_per_order",
        "loss_reason"], rows);
  });

  // --- Editor ---------------------------------------------------------------

  const form = $("quote-form");
  fillSelect(form.elements.status, STATUSES);
  form.elements.lossReason.replaceChildren(new Option("—", ""), ...LOSS_REASONS.map((r) => new Option(r, r)));

  function confirmDiscard() {
    return !dirty || confirm("Discard unsaved changes to this quote?");
  }

  function openQuote(id) {
    if (id !== openId && !confirmDiscard()) return;
    const q = state.quotes.find((x) => x.id === id);
    if (!q) return;
    window.showTab("quotes");
    openId = id;
    draft = JSON.parse(JSON.stringify(q));
    dirty = false;
    fillCustomerSelect(form.elements.customer, q.accountId ? `account:${q.accountId}` : q.leadId ? `lead:${q.leadId}` : "");
    for (const f of ["company", "contactName", "contactTitle", "email", "validDays", "terms", "delivery",
      "discountPct", "taxRate", "status", "lossReason", "notes"]) {
      form.elements[f].value = q[f] ?? "";
    }
    form.elements.taxExempt.checked = !!q.taxExempt;
    $("qe-number").textContent = q.number;
    $("qe-status").textContent = "";
    $("quote-editor").hidden = false;
    closePicker();
    renderMargin();
    renderLines();
    renderEditorMeta();
    renderList();
    // Opening a quote makes its customer the current deal.
    const dealNow = hub.deal.key();
    if (q.accountId && findAccount(q.accountId) && dealNow !== `account:${q.accountId}`) hub.deal.set("account", q.accountId);
    else if (!q.accountId && q.leadId && findLead(q.leadId) && dealNow !== `lead:${q.leadId}`) hub.deal.set("lead", q.leadId);
  }

  function closeQuote() {
    if (!confirmDiscard()) return;
    openId = null;
    draft = null;
    dirty = false;
    $("quote-editor").hidden = true;
    closePicker();
    renderMargin();
    renderList();
  }

  // --- Contract line items: lineup-style builder -----------------------------
  // Built like a DFS lineup: the quote is a numbered list of line-item slots.
  // Picking a slot opens the item picker (major categories + search); choosing
  // an item pulls its cost from the catalog, and the rep prices it by margin %
  // or sell price (each updates the other) before saving the line and moving
  // on to the next one.

  // Quote lines keep a coarse product line ("type") for account coverage and
  // the six-way catalog category for display.
  const CAT_TO_TYPE = { janitorial: "janitorial", breakroom: "janitorial", furniture: "furniture", promo: "apparel", office: "other", printing: "other", other: "other" };
  const CAT_FREQ = { furniture: "once", promo: "once" }; // everything else restocks monthly
  // Rounded up to the cent so the price never lands below the chosen margin; null if the cost or margin is unusable.
  const priceFor = calc.priceFor;
  const marginOf = calc.marginOf;
  const priceText = (cost, m) => {
    const p = priceFor(cost, m);
    return p === null ? "—" : money(p);
  };
  const quoteMargin = () => num(draft && hasValue(draft.defaultMargin) ? draft.defaultMargin : targetMarginPct());
  const catLabel = (k) => (hub.catalog.CATEGORIES[k] || "");
  const discFactor = () => 1 - Math.min(100, Math.max(0, num(draft.discountPct))) / 100;

  function lineCategory(l) {
    if (l.category) return l.category;
    return { furniture: "furniture", apparel: "promo", janitorial: "janitorial" }[l.type] || "other";
  }

  function readHeader() {
    for (const f of ["company", "contactName", "contactTitle", "email", "terms", "status", "lossReason", "notes"]) {
      draft[f] = form.elements[f].value.trim();
    }
    for (const f of ["validDays", "delivery", "discountPct", "taxRate"]) draft[f] = num(form.elements[f].value);
    draft.taxExempt = form.elements.taxExempt.checked;
  }

  function markDirty() {
    dirty = true;
    $("qe-status").textContent = "Unsaved changes";
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderLines() {
    const ul = $("qe-lineup");
    ul.replaceChildren();
    const disc = discFactor();
    const target = targetMarginPct();
    draft.lines.forEach((l, i) => {
      const li = el("li", "lineup-row filled");
      li.dataset.id = l.id;
      const main = el("button", "lineup-main");
      main.type = "button";
      main.dataset.edit = l.id;
      main.setAttribute("aria-label", `Line item ${i + 1}: ${l.name || "unnamed"}. Edit`);
      const who = el("span", "lineup-player");
      who.append(el("strong", "lineup-name", l.name || "(unnamed item)"));
      const meta = [l.sku, catLabel(lineCategory(l)), `${num(l.qty)} × ${l.uom || "each"}`, (FREQS[l.freq] || FREQS.once).label];
      if (l.replaces) meta.push(`replaces ${l.replaces}`);
      who.append(el("span", "lineup-meta", meta.filter(Boolean).join(" · ")));
      const nums = el("span", "lineup-numbers");
      nums.append(el("strong", "lineup-price", `${money(l.unitPrice)} / ${l.uom || "each"}`));
      const m = lineMargin(l, disc);
      const ext = num(l.qty) * num(l.unitPrice) * disc;
      const mt = el("span", "lineup-margin", m === null ? `no cost · ${money(ext)}` : `${pct(m)} margin · ${money(ext)}`);
      if (m !== null && m < target) mt.classList.add("warn");
      if (m !== null && m < 0) mt.classList.add("danger-text");
      nums.append(mt);
      main.append(el("span", "lineup-slot", `#${i + 1}`), who, nums);
      const rm = el("button", "lineup-remove", "×");
      rm.type = "button";
      rm.dataset.remove = l.id;
      rm.setAttribute("aria-label", `Remove line item ${i + 1}`);
      li.append(main, rm);
      ul.append(li);
    });
    // The next open slot, always last.
    const open = el("li", "lineup-row open");
    const pick = el("button", "lineup-main");
    pick.type = "button";
    pick.dataset.pick = "new";
    pick.append(el("span", "lineup-slot", `#${draft.lines.length + 1}`), el("span", "lineup-open-select", "Select item ›"));
    open.append(pick);
    ul.append(open);
    $("qe-default-margin").value = String(quoteMargin());
    renderTotals();
  }

  function renderLineupTotals(t) {
    const target = targetMarginPct();
    const items = [
      ["Line items", String(draft.lines.length)],
      ["Subtotal", money(t.subtotal - t.discount)],
      ["Margin 🔒", t.marginPct === null ? "—" : pct(t.marginPct), t.marginPct !== null && t.marginPct < target ? "warn" : ""],
      ["Gross profit / order 🔒", t.marginPct === null ? "—" : money(t.grossProfit)],
      ["Annual recurring", money(t.recurring)],
      ["Order total", money(t.orderTotal)],
    ];
    const box = $("qe-lineup-totals");
    box.replaceChildren();
    for (const [label, value, cls] of items) {
      const d = el("div", "lineup-total");
      d.append(el("span", "lineup-total-label", label), el("strong", `lineup-total-value ${cls || ""}`, value));
      box.append(d);
    }
    $("qe-lines-aside").textContent = draft.lines.length
      ? `${draft.lines.length} item${draft.lines.length === 1 ? "" : "s"}${t.marginPct === null ? "" : ` · ${pct(t.marginPct)}`}`
      : "No items yet";
  }

  function renderTotals() {
    const t = totals(draft);
    renderLineupTotals(t);
    renderPickerBar(t);
    const target = targetMarginPct();
    const rows = [
      ["Subtotal", money(t.subtotal)],
      ...(t.discount ? [[`Discount (${num(draft.discountPct)}%)`, `−${money(t.discount)}`]] : []),
      [draft.taxExempt ? "Sales tax (exempt)" : `Sales tax (${num(draft.taxRate)}% on taxable lines)`, money(t.tax)],
      ...(num(draft.delivery) ? [["Delivery / installation", money(draft.delivery)]] : []),
      ["Order total", money(t.orderTotal), "grand"],
      ["Annual recurring value", money(t.recurring)],
      ["One-time value", money(t.oneTime)],
      ["Est. annual savings vs. current", t.currentSpend
        ? `${money(t.savings)}${t.savingsPct !== null ? ` (${t.savingsPct.toFixed(1)}%)` : ""}`
        : "Add current prices to calculate", t.savings > 0 ? "good" : ""],
      ["Margin (internal — not on proposal)", t.marginPct === null
        ? "Add unit costs to calculate"
        : `${pct(t.marginPct)} · target ${pct(target)}`,
        `internal ${t.marginPct === null ? "" : t.marginPct < target ? "below" : "good"}`],
      ...(t.marginPct === null ? [] : [
        ["Gross profit per order (internal)", money(t.grossProfit), "internal"],
        ["Gross profit per year (internal)", money(t.annualProfit), "internal"],
      ]),
      ...(t.missingCost ? [[`Cost missing on ${t.missingCost} line${t.missingCost === 1 ? "" : "s"}`, "margin excludes them", "internal below"]] : []),
    ];
    const box = $("qe-totals");
    box.replaceChildren();
    for (const [label, value, cls] of rows) {
      const div = el("div", cls || "");
      div.append(el("span", "", label), el("strong", "", value));
      box.append(div);
    }
  }

  function renderEditorMeta() {
    $("qe-company").textContent = draft.company || "(no customer)";
    $("qe-customer-aside").textContent = [draft.company, draft.contactName].filter(Boolean).join(" · ") || "Choose a customer";
    const badge = $("qe-badge");
    badge.replaceChildren(statusBadge(draft));
    $("qe-loss-wrap").hidden = draft.status !== "lost";
    const meta = [`Created ${hub.fmtDate(draft.created)}`];
    if (draft.sentDate) meta.push(`sent ${hub.fmtDate(draft.sentDate)}`);
    meta.push(`valid until ${hub.fmtDate(validUntil(draft))}`);
    if (draft.decidedDate) meta.push(`${STATUSES[draft.status].toLowerCase()} ${hub.fmtDate(draft.decidedDate)}`);
    $("qe-meta").textContent = meta.join(" · ");

    const c = state.lastComparison;
    const box = $("qe-from-comparison");
    box.hidden = !c;
    if (c) {
      $("qe-comp-product").textContent = c.competitor_product || "competitor product";
      for (const tier of ["good", "better", "best"]) {
        const btn = $(`qe-add-${tier}`);
        const item = c.tiers && c.tiers[tier];
        btn.disabled = !item;
        btn.textContent = item ? `+ ${tier.toUpperCase()}: ${item.name} (${money(item.price)})` : `${tier.toUpperCase()}: no match`;
      }
    }
    const cust = customerFor(draft);
    $("qe-open-customer").hidden = !cust;
  }

  form.addEventListener("input", (e) => {
    if (!draft) return;
    if (e.target.name === "customer") {
      const [kind, id] = e.target.value.split(":");
      const rec = kind === "account" ? findAccount(id) : findLead(id);
      if (rec) {
        applyCustomer(draft, kind, rec);
        for (const f of ["company", "contactName", "contactTitle", "email", "taxRate"]) form.elements[f].value = draft[f];
      }
    }
    readHeader();
    if (e.target.name === "discountPct") renderLines();
    else renderTotals();
    renderEditorMeta();
    markDirty();
  });

  $("qe-lineup").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) {
      draft.lines = draft.lines.filter((l) => l.id !== rm.dataset.remove);
      markDirty();
      renderLines();
      return;
    }
    const edit = e.target.closest("[data-edit]");
    if (edit) return openPicker(edit.dataset.edit);
    if (e.target.closest("[data-pick]")) openPicker(null);
  });

  // One margin for every item: new items start at it, and "Apply to all"
  // re-prices every line that has a cost.
  $("qe-default-margin").addEventListener("input", (e) => {
    if (!draft || e.target.value.trim() === "") return;
    if (!calc.validMargin(e.target.value)) {
      $("qe-status").textContent = MARGIN_RULE; // refused, not silently clamped
      return;
    }
    draft.defaultMargin = Number(e.target.value);
    $("qe-status").textContent = "";
    markDirty();
  });
  $("qe-apply-margin").addEventListener("click", () => {
    const m = quoteMargin();
    const costed = draft.lines.filter((l) => hasValue(l.cost));
    if (!costed.length) {
      $("qe-status").textContent = "No line items have a cost yet — the margin will apply as you add items.";
      return;
    }
    if (!confirm(`Re-price ${costed.length} line item${costed.length === 1 ? "" : "s"} to a ${pct(m)} margin? Prices you set by hand will be replaced.`)) return;
    const priced = costed.filter((l) => priceFor(l.cost, m) !== null);
    for (const l of priced) l.unitPrice = priceFor(l.cost, m);
    markDirty();
    renderLines();
    $("qe-status").textContent = priced.length === costed.length
      ? `Re-priced ${costed.length} line item${costed.length === 1 ? "" : "s"} to ${pct(m)} margin. Unsaved changes.`
      : `Re-priced ${priced.length} of ${costed.length} lines; the rest have a cost that can't be priced. Unsaved changes.`;
  });

  for (const tier of ["good", "better", "best"]) {
    $(`qe-add-${tier}`).addEventListener("click", () => {
      const line = state.lastComparison && lineFromComparison(state.lastComparison, tier);
      if (!line) return;
      draft.lines.push(line);
      markDirty();
      renderLines();
    });
  }

  // --- Item picker -------------------------------------------------------------

  const ip = { lineId: null, cats: new Set(), item: null, category: "other" };
  const ipInputs = ["ip-name", "ip-sku", "ip-cost", "ip-margin", "ip-sell", "ip-qty", "ip-uom", "ip-current"].reduce((o, id) => ((o[id] = $(id)), o), {});
  for (const [k, v] of Object.entries(FREQS)) $("ip-freq").append(new Option(v.label, k));
  const val = (id) => (ipInputs[id].value.trim() === "" ? null : Number(ipInputs[id].value));

  function openPicker(lineId) {
    const line = lineId ? draft.lines.find((l) => l.id === lineId) : null;
    ip.lineId = line ? line.id : null;
    const slot = line ? draft.lines.indexOf(line) + 1 : draft.lines.length + 1;
    $("ip-title").textContent = `Line item #${slot}`;
    $("ip-remove").hidden = !line;
    $("item-picker").hidden = false;
    if (line) showPrice({ line });
    else showChoose();
    renderPickerBar();
  }

  function closePicker() {
    $("item-picker").hidden = true;
    ip.lineId = null;
    ip.item = null;
  }

  function showChoose() {
    $("ip-choose").hidden = false;
    $("ip-price").hidden = true;
    $("ip-step").textContent = "Choose an item";
    renderCats();
    renderResults();
    setTimeout(() => $("ip-search").focus(), 0);
  }

  function renderCats() {
    const counts = hub.catalog.counts();
    const box = $("ip-cats");
    box.replaceChildren();
    for (const [key, label] of Object.entries(hub.catalog.CATEGORIES)) {
      if (key === "other" && !counts.other) continue;
      const lab = el("label", `ip-cat${ip.cats.has(key) ? " on" : ""}`);
      const box2 = document.createElement("input");
      box2.type = "checkbox";
      box2.value = key;
      box2.checked = ip.cats.has(key);
      lab.append(box2, el("span", "ip-cat-name", label), el("span", "ip-cat-count", String(counts[key] || 0)));
      box.append(lab);
    }
    $("ip-cats-clear").hidden = !ip.cats.size;
  }

  function renderResults() {
    const q = $("ip-search").value;
    const { results, total } = hub.catalog.search(ip.cats, q);
    const ul = $("ip-results");
    ul.replaceChildren();
    const empty = !hub.catalog.size();
    $("ip-empty").hidden = !empty;
    const scope = ip.cats.size ? [...ip.cats].map(catLabel).join(", ") : "all categories";
    $("ip-count").textContent = empty ? "" :
      `${total.toLocaleString()} item${total === 1 ? "" : "s"} in ${scope}${q.trim() ? ` matching “${q.trim()}”` : ""}${total > results.length ? ` — showing the first ${results.length}, refine to see more` : ""}`;
    for (const it of results) {
      const li = el("li", "ip-row");
      const b = el("button", "ip-item-btn");
      b.type = "button";
      b.dataset.sku = it.sku || it.id;
      const left = el("span", "ip-item-text");
      left.append(el("strong", "", it.name),
        el("span", "lineup-meta", [it.sku, catLabel(it.cat), it.uom, it.pack].filter(Boolean).join(" · ")));
      const right = el("span", "ip-item-cost");
      right.append(el("strong", "", money(it.cost)), el("span", "lineup-meta", `cost 🔒 → ${priceText(it.cost, quoteMargin())} at ${pct(quoteMargin())}`));
      b.append(left, right, el("span", "ip-plus", "+"));
      b._item = it;
      li.append(b);
      ul.append(li);
    }
  }

  // Fills the pricing step. src: { line } to edit a saved line, { item } for a
  // catalog item, or {} for a custom item. Changing the item on an existing line
  // keeps its quantity, frequency and current price.
  function showPrice(src) {
    const keep = ip.lineId ? draft.lines.find((l) => l.id === ip.lineId) : null;
    $("ip-choose").hidden = true;
    $("ip-price").hidden = false;
    $("ip-step").textContent = "Price this item";
    let v;
    if (src.line) {
      const l = src.line;
      v = { name: l.name, sku: l.sku, cost: l.cost, sell: l.unitPrice, qty: l.qty, uom: l.uom, freq: l.freq, current: l.currentPrice, taxable: l.taxable, category: lineCategory(l) };
      v.margin = hasValue(l.cost) ? marginOf(l.cost, l.unitPrice) : quoteMargin();
    } else if (src.item) {
      const it = src.item;
      const m = quoteMargin();
      v = { name: it.name, sku: it.sku, cost: it.cost, margin: m, sell: priceFor(it.cost, m) ?? "", qty: keep ? keep.qty : 1, uom: it.uom || "each",
        freq: keep ? keep.freq : CAT_FREQ[it.cat] || "month", current: keep ? keep.currentPrice : "", taxable: keep ? keep.taxable : true, category: it.cat };
    } else {
      v = { name: "", sku: "", cost: "", margin: quoteMargin(), sell: "", qty: keep ? keep.qty : 1, uom: "each", freq: "month", current: "", taxable: true, category: "other" };
    }
    ip.item = src.item || null;
    ip.category = v.category;
    ipInputs["ip-name"].value = v.name || "";
    ipInputs["ip-sku"].value = v.sku || "";
    ipInputs["ip-cost"].value = hasValue(v.cost) ? num(v.cost).toFixed(2) : "";
    ipInputs["ip-margin"].value = v.margin === null || v.margin === undefined ? "" : (Math.round(v.margin * 10) / 10).toString();
    ipInputs["ip-sell"].value = hasValue(v.sell) && v.sell !== 0 ? num(v.sell).toFixed(2) : "";
    ipInputs["ip-qty"].value = v.qty ?? 1;
    ipInputs["ip-uom"].value = v.uom || "each";
    ipInputs["ip-current"].value = hasValue(v.current) ? v.current : "";
    $("ip-freq").value = v.freq || "month";
    $("ip-taxable").checked = v.taxable !== false;
    $("ip-cat-label").textContent = catLabel(v.category) || "Custom item";
    $("ip-from-catalog").hidden = !ip.item;
    renderPriceResults();
    setTimeout(() => (v.name ? ipInputs["ip-margin"] : ipInputs["ip-name"]).focus(), 0);
  }

  function renderPriceResults() {
    const cost = val("ip-cost");
    const sell = val("ip-sell");
    const qty = val("ip-qty") ?? 0;
    const ok = cost !== null && sell !== null && sell > 0;
    const m = ok ? marginOf(cost, sell) : null;
    const disc = discFactor();
    $("ip-profit").textContent = ok ? money(sell - cost) : "—";
    $("ip-ext").textContent = sell !== null ? money(sell * qty) : "—";
    $("ip-markup").textContent = ok && cost > 0 ? pct(((sell - cost) / cost) * 100) : "—";
    $("ip-gp").textContent = ok ? money((sell - cost) * qty) : "—";
    const target = targetMarginPct();
    const note = $("ip-vs-target");
    note.className = "hint";
    if (m === null) note.textContent = cost === null ? "Enter a cost to see the margin." : "";
    else {
      const diff = m - target;
      note.textContent = Math.abs(diff) < 0.05 ? `On your ${pct(target)} target.` : `${Math.abs(diff).toFixed(1)} pts ${diff > 0 ? "above" : "below"} your ${pct(target)} target.`;
      if (diff >= 0.05) note.className = "hint good";
      else if (diff <= -0.05) note.className = "hint warn";
      if (disc < 1) note.textContent += ` The quote's ${num(draft.discountPct)}% discount brings this line to ${pct(marginOf(cost, sell * disc))}.`;
    }
  }

  // Margin and sell price drive each other; cost re-prices at the current margin.
  function repriceFromMargin() {
    const cost = val("ip-cost");
    const m = val("ip-margin");
    if (cost === null || m === null) return;
    const p = priceFor(cost, m);
    // An impossible margin (100% or more) or cost is refused with a reason, never turned into a price.
    $("ip-error").textContent = p === null ? (calc.validMargin(m) ? "Cost must be zero or more." : MARGIN_RULE) : "";
    if (p !== null) ipInputs["ip-sell"].value = p.toFixed(2);
  }
  ipInputs["ip-margin"].addEventListener("input", () => {
    repriceFromMargin();
    renderPriceResults();
  });
  ipInputs["ip-sell"].addEventListener("input", () => {
    const cost = val("ip-cost");
    const sell = val("ip-sell");
    if (cost !== null && sell !== null && sell > 0) ipInputs["ip-margin"].value = (Math.round(marginOf(cost, sell) * 10) / 10).toString();
    renderPriceResults();
  });
  ipInputs["ip-cost"].addEventListener("input", () => {
    repriceFromMargin();
    renderPriceResults();
  });
  for (const id of ["ip-qty"]) ipInputs[id].addEventListener("input", renderPriceResults);

  function savePickedLine() {
    const name = ipInputs["ip-name"].value.trim();
    const sell = val("ip-sell");
    if (!name) {
      $("ip-error").textContent = "Give the item a name.";
      ipInputs["ip-name"].focus();
      return false;
    }
    if (sell === null || !(sell > 0)) {
      $("ip-error").textContent = "Set a sell price (or a margin, once there's a cost).";
      ipInputs["ip-sell"].focus();
      return false;
    }
    $("ip-error").textContent = "";
    const cost = val("ip-cost");
    const category = ip.category || "other";
    const fields = {
      sku: ipInputs["ip-sku"].value.trim(),
      name,
      category,
      type: CAT_TO_TYPE[category] || "other",
      qty: val("ip-qty") ?? 1,
      uom: ipInputs["ip-uom"].value.trim() || "each",
      freq: $("ip-freq").value,
      unitPrice: sell,
      cost: cost === null ? "" : cost,
      currentPrice: val("ip-current") === null ? "" : val("ip-current"),
      taxable: $("ip-taxable").checked,
    };
    const existing = ip.lineId && draft.lines.find((l) => l.id === ip.lineId);
    if (existing) Object.assign(existing, fields);
    else draft.lines.push({ id: hub.newId("ln"), tier: "", replaces: "", ...fields });
    markDirty();
    renderLines();
    return true;
  }

  $("ip-save").addEventListener("click", () => {
    if (savePickedLine()) closePicker();
  });
  $("ip-save-next").addEventListener("click", () => {
    if (!savePickedLine()) return;
    openPicker(null);
  });
  $("ip-back").addEventListener("click", closePicker);
  $("ip-change").addEventListener("click", showChoose);
  $("ip-remove").addEventListener("click", () => {
    if (!ip.lineId) return;
    draft.lines = draft.lines.filter((l) => l.id !== ip.lineId);
    markDirty();
    renderLines();
    closePicker();
  });
  $("ip-custom").addEventListener("click", () => showPrice({}));
  $("ip-search").addEventListener("input", renderResults);
  $("ip-cats").addEventListener("change", (e) => {
    if (e.target.checked) ip.cats.add(e.target.value);
    else ip.cats.delete(e.target.value);
    renderCats();
    renderResults();
  });
  $("ip-cats-clear").addEventListener("click", () => {
    ip.cats.clear();
    renderCats();
    renderResults();
  });
  $("ip-results").addEventListener("click", (e) => {
    const b = e.target.closest(".ip-item-btn");
    if (b && b._item) showPrice({ item: b._item });
  });
  $("ip-load-sample").addEventListener("click", () => {
    hub.catalog.loadSample();
    renderCats();
    renderResults();
  });
  // Esc steps back out of the picker before it closes the whole quote panel.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || $("item-picker").hidden) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (!$("ip-price").hidden && !ip.lineId) showChoose();
    else closePicker();
  }, true);

  function renderPickerBar(t = draft && totals(draft)) {
    if (!t || $("item-picker").hidden) return;
    const target = targetMarginPct();
    $("ip-bar-lines").textContent = String(draft.lines.length);
    $("ip-bar-subtotal").textContent = money(t.subtotal - t.discount);
    const mEl = $("ip-bar-margin");
    mEl.textContent = t.marginPct === null ? "—" : pct(t.marginPct);
    mEl.className = `picker-bar-value ${t.marginPct !== null && t.marginPct < target ? "warn" : ""}`;
    $("ip-bar-target").textContent = `target ${pct(target)}`;
  }

  function commit(message) {
    readHeader();
    const q = state.quotes.find((x) => x.id === openId);
    if (!q) return null;
    const becameWon = q.status !== "won" && draft.status === "won";
    if (q.status !== draft.status) applyStatusSideEffects(draft, q.status);
    Object.assign(q, draft, { updated: new Date().toISOString() });
    dirty = false;
    hub.save();
    // A won deal carries on as its account (next step: onboarding).
    if (becameWon && q.accountId) hub.deal.set("account", q.accountId);
    form.elements.status.value = q.status;
    $("qe-status").textContent = message || "Saved.";
    renderEditorMeta();
    return q;
  }

  // Keeps dates, the lead's pipeline stage and the account in step with status.
  function applyStatusSideEffects(q, previous) {
    const lead = q.leadId && findLead(q.leadId);
    if (["sent", "negotiating"].includes(q.status) && !q.sentDate) q.sentDate = hub.today();
    if (["won", "lost"].includes(q.status)) q.decidedDate = hub.today();
    else q.decidedDate = "";
    if (lead && ["sent", "negotiating"].includes(q.status) &&
        ["new", "enriched", "verified", "contacted", "qualified"].includes(lead.stage)) {
      lead.stage = "proposal";
      lead.updated = new Date().toISOString();
    }
    if (q.status === "won") {
      if (lead) {
        lead.stage = "won";
        lead.updated = new Date().toISOString();
      }
      const acct = hub.accounts.upsertFromQuote(q);
      q.accountId = acct.id;
    } else if (previous === "won" && q.accountId) {
      hub.accounts.log(q.accountId, "note", `Quote ${q.number} moved from Won back to ${STATUSES[q.status]}.`);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    commit();
  });
  $("qe-save").addEventListener("click", () => commit());

  function setStatus(status, message) {
    if (!draft) return;
    if (status === "won" && !draft.lines.length) {
      $("qe-status").textContent = "Add at least one line before marking the quote won.";
      return;
    }
    form.elements.status.value = status;
    commit(message);
  }
  $("qe-mark-sent").addEventListener("click", () => setStatus("sent", "Marked sent — the lead moved to Proposal sent."));
  $("qe-mark-won").addEventListener("click", () => setStatus("won", "Won — the account has been created/updated in the Accounts tab."));
  $("qe-mark-lost").addEventListener("click", () => {
    form.elements.status.value = "lost";
    readHeader();
    renderEditorMeta();
    form.elements.lossReason.focus();
    $("qe-status").textContent = "Pick a loss reason, then Save.";
    dirty = true;
  });

  $("qe-close").addEventListener("click", closeQuote);
  $("qe-delete").addEventListener("click", () => {
    const q = state.quotes.find((x) => x.id === openId);
    if (!q || !confirm(`Delete quote ${q.number}?`)) return;
    state.quotes = state.quotes.filter((x) => x.id !== openId);
    dirty = false;
    closeQuote();
    hub.save();
  });
  $("qe-duplicate").addEventListener("click", () => {
    if (!confirmDiscard()) return;
    const src = state.quotes.find((x) => x.id === openId);
    if (!src) return;
    const copy = newQuote(null);
    Object.assign(copy, JSON.parse(JSON.stringify(src)), {
      id: copy.id, number: copy.number, status: "draft", created: copy.created, updated: copy.updated,
      sentDate: "", decidedDate: "", lossReason: "",
    });
    copy.lines.forEach((l) => (l.id = hub.newId("ln")));
    dirty = false;
    hub.save();
    openQuote(copy.id);
  });
  $("qe-open-customer").addEventListener("click", () => {
    const q = draft;
    if (q.accountId && findAccount(q.accountId)) hub.accounts.open(q.accountId);
    else if (q.leadId) hub.openLead(q.leadId);
  });

  // --- Margin calculator ------------------------------------------------------
  // Target margin persists in the shared store (localStorage). Changing the cost
  // (or the target) re-prices the sell field at the target; editing the sell
  // price directly shows the margin that price actually gives.

  state.settings = state.settings || {};
  const mTarget = $("m-target");
  const mCost = $("m-cost");
  const mSell = $("m-sell");
  const mQty = $("m-qty");

  const parseNum = (el) => (el.value.trim() === "" ? null : Number(el.value));
  function targetMargin() {
    const t = parseNum(mTarget);
    return t === null || !calc.validMargin(t) ? null : t;
  }

  function priceAtTarget() {
    const cost = parseNum(mCost);
    const t = targetMargin();
    if (parseNum(mTarget) !== null && t === null) {
      mSell.value = "";
      $("m-sell-hint").textContent = MARGIN_RULE;
      return;
    }
    const price = cost === null || t === null ? null : priceFor(cost, t);
    if (price === null) {
      mSell.value = "";
      return;
    }
    // Rounded up to the cent so the price never lands below the target margin.
    mSell.value = price.toFixed(2);
    $("m-sell-hint").textContent = `Priced at your ${pct(t)} target`;
  }

  function renderMargin() {
    const cost = parseNum(mCost);
    const sell = parseNum(mSell);
    const qty = parseNum(mQty) ?? 1;
    const ok = cost !== null && sell !== null && sell > 0 && cost >= 0;
    const profit = ok ? sell - cost : null;
    const margin = ok ? (profit / sell) * 100 : null;
    $("m-margin").textContent = ok ? pct(margin) : "—";
    $("m-profit").textContent = ok ? money(profit) : "—";
    $("m-total").textContent = ok ? money(profit * qty) : "—";
    $("m-markup").textContent = ok && cost > 0 ? pct((profit / cost) * 100) : "—";

    const t = targetMargin();
    const vs = $("m-vs-target");
    vs.className = "hint";
    if (ok && t !== null) {
      const diff = margin - t;
      if (Math.abs(diff) < 0.05) vs.textContent = `On target (${pct(t)}).`;
      else {
        vs.textContent = `${Math.abs(diff).toFixed(1)} pts ${diff > 0 ? "above" : "below"} your ${pct(t)} target.`;
        vs.className = diff > 0 ? "hint good" : "hint warn";
      }
    } else {
      vs.textContent = "";
    }
    $("m-margin").className = ok && margin < 0 ? "danger-text" : "";
  }

  function saveTarget() {
    const t = targetMargin();
    if (t === null) return;
    mTarget.value = String(t);
    state.settings.targetMargin = t;
    hub.save();
  }

  mTarget.value = String(state.settings.targetMargin ?? DEFAULT_TARGET_MARGIN);
  mTarget.addEventListener("input", () => {
    priceAtTarget();
    renderMargin();
  });
  mTarget.addEventListener("change", saveTarget);
  mCost.addEventListener("input", () => {
    priceAtTarget();
    renderMargin();
  });
  mSell.addEventListener("input", () => {
    $("m-sell-hint").textContent = "Your price — margin recalculated";
    renderMargin();
  });
  mQty.addEventListener("input", renderMargin);
  $("margin-form").addEventListener("submit", (e) => e.preventDefault());
  renderMargin();

  // --- Printable proposal ---------------------------------------------------

  const profileForm = $("rep-profile");
  for (const f of ["repName", "repEmail", "repPhone", "repAddress"]) {
    profileForm.elements[f].value = (state.profile || {})[f] || "";
  }
  profileForm.addEventListener("change", () => {
    state.profile = Object.fromEntries(
      ["repName", "repEmail", "repPhone", "repAddress"].map((f) => [f, profileForm.elements[f].value.trim()]));
    hub.save();
  });

  // Customer-facing. Only the fields listed here are printed; never add a line's
  // cost or any margin figure (those stay internal to the editor and exports).
  function proposalHtml(q) {
    const t = totals(q);
    const p = state.profile || {};
    const cust = customerFor(q) || {};
    const disc = 1 - Math.min(100, Math.max(0, num(q.discountPct))) / 100;
    const addr = [cust.address, [[cust.city, cust.state].filter(Boolean).join(", "), cust.zip].filter(Boolean).join(" ")]
      .filter(Boolean).join(", ");
    const lines = q.lines.map((l) => `
      <tr>
        <td>${esc(l.sku)}</td>
        <td>${esc(l.name)}${l.replaces ? `<div class="sub">Replaces: ${esc(l.replaces)}</div>` : ""}</td>
        <td>${esc(l.tier ? l.tier[0].toUpperCase() + l.tier.slice(1) : "")}</td>
        <td class="num">${esc(l.qty)} ${esc(l.uom)}</td>
        <td>${esc((FREQS[l.freq] || FREQS.once).label)}</td>
        <td class="num">${money(num(l.unitPrice) * disc)}</td>
        <td class="num">${money(num(l.qty) * num(l.unitPrice) * disc)}</td>
      </tr>`).join("");
    const savingsLine = t.currentSpend && t.savings > 0
      ? `<p class="savings">Compared with your current pricing, this proposal is estimated to save <strong>${money(t.savings)} per year${t.savingsPct !== null ? ` (${t.savingsPct.toFixed(1)}%)` : ""}</strong>.</p>`
      : "";
    return `
      <header>
        <div><h1>Office Basics</h1><div>${esc(p.repAddress)}</div></div>
        <div class="right"><h2>Proposal ${esc(q.number)}</h2>
          <div>Date: ${hub.fmtDate(q.sentDate || hub.today())}</div>
          <div>Valid until: ${hub.fmtDate(validUntil(q))}</div></div>
      </header>
      <section class="parties">
        <div><h3>Prepared for</h3><strong>${esc(q.company)}</strong>
          ${q.contactName ? `<div>Attn: ${esc(q.contactName)}${q.contactTitle ? `, ${esc(q.contactTitle)}` : ""}</div>` : ""}
          ${addr ? `<div>${esc(addr)}</div>` : ""}${q.email ? `<div>${esc(q.email)}</div>` : ""}</div>
        <div><h3>Prepared by</h3><strong>${esc(p.repName || "Office Basics")}</strong>
          ${p.repEmail ? `<div>${esc(p.repEmail)}</div>` : ""}${p.repPhone ? `<div>${esc(p.repPhone)}</div>` : ""}</div>
      </section>
      ${q.notes ? `<section><h3>Scope</h3><p>${esc(q.notes).replace(/\n/g, "<br>")}</p></section>` : ""}
      ${savingsLine}
      <table>
        <thead><tr><th>SKU</th><th>Description</th><th>Tier</th><th>Qty</th><th>Frequency</th><th>Unit price</th><th>Extended</th></tr></thead>
        <tbody>${lines}</tbody>
      </table>
      <div class="totals">
        <div><span>Subtotal</span><strong>${money(t.subtotal - t.discount)}</strong></div>
        <div><span>${q.taxExempt ? "Sales tax (exempt)" : "Sales tax"}</span><strong>${money(t.tax)}</strong></div>
        ${num(q.delivery) ? `<div><span>Delivery / installation</span><strong>${money(q.delivery)}</strong></div>` : ""}
        <div class="grand"><span>Order total</span><strong>${money(t.orderTotal)}</strong></div>
        ${t.recurring ? `<div><span>Estimated annual recurring value</span><strong>${money(t.recurring)}</strong></div>` : ""}
      </div>
      <section><h3>Terms</h3>
        <p>Payment terms: ${esc(q.terms || "Net 30")}. Pricing valid until ${hub.fmtDate(validUntil(q))}. Recurring items are billed per delivery at the prices above; quantities may be adjusted per order.${q.taxExempt ? " Tax-exempt status requires a valid exemption certificate on file." : ""}</p>
      </section>
      <section class="sign">
        <div><div class="line"></div>Accepted by (name &amp; title)</div>
        <div><div class="line"></div>Signature</div>
        <div><div class="line"></div>Date</div>
      </section>`;
  }

  $("qe-print").addEventListener("click", () => {
    const q = commit("Saved — opening print dialog (choose “Save as PDF” to email it).");
    if (!q) return;
    $("proposal-print").innerHTML = proposalHtml(q);
    document.body.classList.add("print-proposal");
    window.print();
  });
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("print-proposal");
    $("proposal-print").innerHTML = ""; // don't leave the rendered proposal sitting in the page
  });

  // --- Entry points used by other tabs ----------------------------------------

  function quoteForCustomer(kind, record) {
    const existing = state.quotes
      .filter((q) => q.status === "draft" && (kind === "account" ? q.accountId === record.id : q.leadId === record.id))
      .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""))[0];
    return existing || newQuote({ kind, record });
  }

  hub.quotes = {
    totals,
    STATUSES,
    isExpired,
    validUntil,
    open: openQuote,
    newForLead(leadId) {
      const lead = findLead(leadId);
      if (!lead || !confirmDiscard()) return;
      dirty = false;
      const q = newQuote({ kind: "lead", record: lead });
      hub.save();
      openQuote(q.id);
    },
    newForAccount(accountId) {
      const acct = findAccount(accountId);
      if (!acct || !confirmDiscard()) return;
      dirty = false;
      const q = newQuote({ kind: "account", record: acct });
      hub.save();
      openQuote(q.id);
    },
    // From the Cost Comparison tab: add a tier to the active lead's draft quote.
    addComparisonTier(tier) {
      const c = state.lastComparison;
      const line = c && lineFromComparison(c, tier);
      if (!line) return "No match for that tier.";
      if (!confirmDiscard()) return "";
      dirty = false;
      const deal = hub.deal.resolve();
      const acct = deal && deal.acct;
      const lead = deal && deal.lead;
      const q = acct ? quoteForCustomer("account", acct) : lead ? quoteForCustomer("lead", lead) : newQuote(null);
      q.lines.push(line);
      q.updated = new Date().toISOString();
      hub.save();
      openQuote(q.id);
      return "";
    },
  };

  hub.on(() => {
    renderAll();
    renderMargin();
    if (draft) {
      const q = state.quotes.find((x) => x.id === openId);
      if (!q) {
        dirty = false;
        closeQuote();
      } else if (!dirty) {
        fillCustomerSelect(form.elements.customer, form.elements.customer.value);
        renderEditorMeta();
      }
    }
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  renderAll();
})();
