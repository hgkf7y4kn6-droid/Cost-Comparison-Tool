// Proposals & Quotes tab: build quotes for qualified leads / accounts, pull in
// good/better/best lines from the Cost Comparison tab, show savings vs. the
// customer's current pricing, print a proposal, and track sent → won/lost.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money, esc } = hub;

  const STATUSES = {
    draft: "Draft",
    sent: "Sent",
    negotiating: "Negotiating",
    won: "Won",
    lost: "Lost",
  };
  const OPEN_STATUSES = ["draft", "sent", "negotiating"];

  const FREQS = {
    once: { label: "One-time", mult: 1, recurring: false },
    month: { label: "Monthly", mult: 12, recurring: true },
    quarter: { label: "Quarterly", mult: 4, recurring: true },
    year: { label: "Annually", mult: 1, recurring: true },
  };

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

  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  function totals(q) {
    const disc = Math.min(100, Math.max(0, num(q.discountPct))) / 100;
    let subtotal = 0, taxableNet = 0, recurring = 0, oneTime = 0, savings = 0, currentSpend = 0;
    for (const l of q.lines) {
      const ext = num(l.qty) * num(l.unitPrice);
      const net = ext * (1 - disc);
      const f = FREQS[l.freq] || FREQS.once;
      subtotal += ext;
      if (l.taxable) taxableNet += net;
      if (f.recurring) recurring += net * f.mult;
      else oneTime += net;
      if (l.currentPrice !== "" && l.currentPrice !== undefined && l.currentPrice !== null) {
        const current = num(l.qty) * num(l.currentPrice) * f.mult;
        currentSpend += current;
        savings += current - net * f.mult;
      }
    }
    const discount = subtotal * disc;
    const tax = q.taxExempt ? 0 : (taxableNet * num(q.taxRate)) / 100;
    const orderTotal = subtotal - discount + tax + num(q.delivery);
    return {
      subtotal, discount, tax, orderTotal, recurring, oneTime,
      firstYear: recurring + oneTime,
      savings, currentSpend,
      savingsPct: currentSpend > 0 ? (savings / currentSpend) * 100 : null,
    };
  }

  const validUntil = (q) => hub.addDays((q.sentDate || q.created || hub.today()).slice(0, 10), q.validDays || 30);
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
    if (c.competitor_cost_per_use && item.uses_per_case) current = +(c.competitor_cost_per_use * item.uses_per_case).toFixed(2);
    return {
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
      taxable: type !== "apparel",
      replaces: c.competitor_product || "",
    };
  }

  function blankLine() {
    return { id: hub.newId("ln"), sku: "", name: "", type: "janitorial", tier: "", qty: 1, uom: "case",
      freq: "month", unitPrice: 0, currentPrice: "", taxable: true, replaces: "" };
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
    ];
    renderTiles($("q-kpis"), tiles);
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
        hub.fmtDate(validUntil(q)),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement("td");
        if (i === 2) td.append(statusBadge(q));
        else td.textContent = text;
        if (i >= 3 && i <= 6) td.className = "num";
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
        rows.push([q.number, q.company, STATUSES[q.status], isExpired(q) ? "yes" : "", q.created.slice(0, 10),
          q.sentDate || "", q.decidedDate || "", l.sku, l.name, LINE_TYPES[l.type] || "", l.tier, l.qty, l.uom,
          FREQS[l.freq] ? FREQS[l.freq].label : "", l.unitPrice, l.currentPrice, t.orderTotal.toFixed(2),
          t.recurring.toFixed(2), t.oneTime.toFixed(2), t.savings.toFixed(2), q.lossReason]);
      }
    }
    hub.downloadCsv(`quotes-${hub.today()}.csv`,
      ["quote", "company", "status", "expired", "created", "sent", "decided", "sku", "description", "product_line",
        "tier", "qty", "uom", "frequency", "unit_price", "current_price", "order_total", "annual_recurring",
        "one_time", "annual_savings", "loss_reason"], rows);
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
    renderLines();
    renderEditorMeta();
    renderList();
    $("quote-editor").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function closeQuote() {
    if (!confirmDiscard()) return;
    openId = null;
    draft = null;
    dirty = false;
    $("quote-editor").hidden = true;
    renderList();
  }

  function readHeader() {
    for (const f of ["company", "contactName", "contactTitle", "email", "terms", "status", "lossReason", "notes"]) {
      draft[f] = form.elements[f].value.trim();
    }
    for (const f of ["validDays", "delivery", "discountPct", "taxRate"]) draft[f] = num(form.elements[f].value);
    draft.taxExempt = form.elements.taxExempt.checked;
  }

  function lineInput(line, field, attrs) {
    const el = attrs.options ? document.createElement("select") : document.createElement("input");
    if (attrs.options) {
      for (const [v, label] of Object.entries(attrs.options)) el.append(new Option(label, v));
    } else {
      el.type = attrs.type || "text";
      if (attrs.step) el.step = attrs.step;
      if (attrs.min !== undefined) el.min = attrs.min;
      if (attrs.placeholder) el.placeholder = attrs.placeholder;
    }
    if (el.type === "checkbox") el.checked = !!line[field];
    else el.value = line[field] ?? "";
    el.dataset.field = field;
    el.setAttribute("aria-label", attrs.label);
    return el;
  }

  function renderLines() {
    const tbody = $("qe-lines");
    tbody.replaceChildren();
    for (const line of draft.lines) {
      const tr = document.createElement("tr");
      tr.dataset.id = line.id;
      const tiers = { "": "—", good: "Good", better: "Better", best: "Best" };
      const fields = [
        ["sku", { label: "SKU" }],
        ["name", { label: "Description" }],
        ["type", { label: "Product line", options: LINE_TYPES }],
        ["tier", { label: "Tier", options: tiers }],
        ["qty", { label: "Quantity", type: "number", min: 0, step: "any" }],
        ["uom", { label: "Unit of measure" }],
        ["freq", { label: "Frequency", options: Object.fromEntries(Object.entries(FREQS).map(([k, v]) => [k, v.label])) }],
        ["unitPrice", { label: "Unit price", type: "number", min: 0, step: "0.01" }],
        ["currentPrice", { label: "Current price (customer pays today)", type: "number", min: 0, step: "0.01", placeholder: "optional" }],
        ["taxable", { label: "Taxable", type: "checkbox" }],
      ];
      for (const [field, attrs] of fields) {
        const td = document.createElement("td");
        td.append(lineInput(line, field, attrs));
        if (field === "name" && line.replaces) {
          const sub = document.createElement("div");
          sub.className = "sub";
          sub.textContent = `Replaces: ${line.replaces}`;
          td.append(sub);
        }
        tr.append(td);
      }
      const ext = document.createElement("td");
      ext.className = "num ext";
      tr.append(ext);
      const del = document.createElement("td");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn danger-text";
      btn.textContent = "✕";
      btn.setAttribute("aria-label", "Remove line");
      btn.dataset.remove = line.id;
      del.append(btn);
      tr.append(del);
      tbody.append(tr);
    }
    $("qe-no-lines").hidden = draft.lines.length > 0;
    renderTotals();
  }

  function readLines() {
    for (const tr of $("qe-lines").querySelectorAll("tr[data-id]")) {
      const line = draft.lines.find((l) => l.id === tr.dataset.id);
      if (!line) continue;
      for (const el of tr.querySelectorAll("[data-field]")) {
        const f = el.dataset.field;
        if (el.type === "checkbox") line[f] = el.checked;
        else if (f === "qty" || f === "unitPrice") line[f] = num(el.value);
        else if (f === "currentPrice") line[f] = el.value === "" ? "" : num(el.value);
        else line[f] = el.value.trim();
      }
    }
  }

  function renderTotals() {
    const t = totals(draft);
    const disc = 1 - Math.min(100, Math.max(0, num(draft.discountPct))) / 100;
    for (const tr of $("qe-lines").querySelectorAll("tr[data-id]")) {
      const line = draft.lines.find((l) => l.id === tr.dataset.id);
      if (line) tr.querySelector(".ext").textContent = money(num(line.qty) * num(line.unitPrice) * disc);
    }
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
    ];
    const box = $("qe-totals");
    box.replaceChildren();
    for (const [label, value, cls] of rows) {
      const div = document.createElement("div");
      if (cls) div.className = cls;
      const a = document.createElement("span");
      a.textContent = label;
      const b = document.createElement("strong");
      b.textContent = value;
      div.append(a, b);
      box.append(div);
    }
  }

  function renderEditorMeta() {
    $("qe-company").textContent = draft.company || "(no customer)";
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
    dirty = true;
    if (e.target.name === "customer") {
      const [kind, id] = e.target.value.split(":");
      const rec = kind === "account" ? findAccount(id) : findLead(id);
      if (rec) {
        applyCustomer(draft, kind, rec);
        for (const f of ["company", "contactName", "contactTitle", "email", "taxRate"]) form.elements[f].value = draft[f];
      }
    }
    readHeader();
    readLines();
    if (e.target.dataset.field === "type") {
      // Apparel is generally sales-tax exempt in PA/NJ; furniture is usually one-time.
      const line = draft.lines.find((l) => l.id === e.target.closest("tr").dataset.id);
      line.taxable = line.type !== "apparel";
      line.freq = DEFAULT_FREQ[line.type];
      renderLines();
    }
    renderTotals();
    renderEditorMeta();
    $("qe-status").textContent = "Unsaved changes";
  });

  $("qe-lines").addEventListener("click", (e) => {
    const id = e.target.dataset.remove;
    if (!id) return;
    readLines();
    draft.lines = draft.lines.filter((l) => l.id !== id);
    dirty = true;
    renderLines();
  });

  $("qe-add-line").addEventListener("click", () => {
    readLines();
    draft.lines.push(blankLine());
    dirty = true;
    renderLines();
    $("qe-lines").lastElementChild.querySelector("input").focus();
  });

  for (const tier of ["good", "better", "best"]) {
    $(`qe-add-${tier}`).addEventListener("click", () => {
      const line = state.lastComparison && lineFromComparison(state.lastComparison, tier);
      if (!line) return;
      readLines();
      draft.lines.push(line);
      dirty = true;
      renderLines();
    });
  }

  function commit(message) {
    readHeader();
    readLines();
    const q = state.quotes.find((x) => x.id === openId);
    if (!q) return null;
    if (q.status !== draft.status) applyStatusSideEffects(draft, q.status);
    Object.assign(q, draft, { updated: new Date().toISOString() });
    dirty = false;
    hub.save();
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
  window.addEventListener("afterprint", () => document.body.classList.remove("print-proposal"));

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
      const lead = findLead(state.activeLeadId);
      const acct = lead && state.accounts.find((a) => a.leadId === lead.id);
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
