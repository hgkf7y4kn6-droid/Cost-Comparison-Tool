// Orders and the rep's "book of business" on the Accounts tab.
//
// An order is an invoice on an account (account.orders):
//   { id, number, date, po, status, tax, freight, notes, source,
//     lines: [{ sku, name, qty, shipped, backordered, unitPrice, cost }] }
// Spend is merchandise billed: shipped quantity × unit price. Tax and freight
// show on the invoice but don't count as spend, and back-ordered units count
// when they ship. accounts_store.py computes YTD the same way on the server.
//
// The Accounts tab opens with a summary card (active accounts, YTD and MTD
// orders) and one expandable card per account the rep owns: collapsed it
// shows the company, margin % and YTD orders; expanded, its contacts and its
// orders, newest first, each opening the invoice. Back-ordered orders are flagged.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money, calc } = hub;

  const STATUSES = { open: "Open", shipped: "Shipped", invoiced: "Invoiced", paid: "Paid" };
  const { num, hasValue: has, billedQty, backordered } = calc;
  const pct = (n) => `${n.toFixed(1)}%`;

  // --- Order math (calc.js) ----------------------------------------------------

  const orderTotals = calc.orderTotals;

  // Year and month follow the rep's local calendar (the same "today" as everywhere else).
  const year = () => hub.today().slice(0, 4);
  const month = () => hub.today().slice(0, 7);

  function spendSince(acct, prefix) {
    let total = 0, count = 0;
    for (const o of acct.orders || []) {
      if (!String(o.date || "").startsWith(prefix)) continue;
      total += orderTotals(o).merch;
      count++;
    }
    // Amounts logged on "order" activities that haven't been turned into orders yet.
    for (const a of acct.activities || []) {
      if (a.type === "order" && !a.orderId && Number(a.amount) > 0 && String(a.date || "").startsWith(prefix)) {
        total += Number(a.amount);
        count++;
      }
    }
    return { total, count };
  }
  const ytd = (acct) => spendSince(acct, year());
  const mtd = (acct) => spendSince(acct, month());

  // Account margin: this year's invoiced lines that have a cost; if none, the won proposals.
  function margin(acct) {
    let costed = 0, cost = 0;
    for (const o of acct.orders || []) {
      if (!String(o.date || "").startsWith(year())) continue;
      const t = orderTotals(o);
      costed += t.costed;
      cost += t.cost;
    }
    if (costed > 0) return { pct: ((costed - cost) / costed) * 100, from: "orders" };
    let rev = 0, gp = 0;
    for (const q of state.quotes.filter((q) => q.status === "won" && (q.accountId === acct.id || (acct.leadId && q.leadId === acct.leadId)))) {
      const t = hub.quotes.totals(q);
      rev += t.costedRevenue;
      gp += t.grossProfit;
    }
    return rev > 0 ? { pct: (gp / rev) * 100, from: "proposal" } : null;
  }

  const byNewest = (a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.number || "").localeCompare(String(a.number || ""));

  // Order amounts logged on activities (before invoices existed) become orders,
  // once, so every view reads one list.
  function convertLoggedOrders() {
    let changed = false;
    for (const acct of state.accounts) {
      for (const a of acct.activities || []) {
        if (a.type !== "order" || a.orderId || !(Number(a.amount) > 0)) continue;
        const order = {
          id: hub.newId("ord"),
          number: "",
          date: a.date || hub.today(),
          po: "",
          status: "invoiced",
          tax: 0,
          freight: 0,
          notes: a.text || "",
          source: "logged",
          lines: [{ sku: "", name: a.text || "Order", qty: 1, shipped: 1, backordered: 0, unitPrice: Number(a.amount), cost: "" }],
        };
        acct.orders = [...(acct.orders || []), order];
        a.orderId = order.id;
        changed = true;
      }
    }
    return changed;
  }

  // --- Book of business (Accounts tab) ----------------------------------------

  const mine = () => {
    const me = hub.auth && hub.auth.email;
    return state.accounts.filter((a) => a.status !== "churned" && (!a.ownerEmail || a.ownerEmail === me));
  };

  function renderBook() {
    const accounts = mine();
    const y = accounts.map(ytd), m = accounts.map(mtd);
    const sum = (list, k) => list.reduce((s, x) => s + x[k], 0);
    const ordersWord = (n) => `${n} order${n === 1 ? "" : "s"}`;
    hub.renderTiles($("a-kpis"), [
      ["Active accounts", String(accounts.length), `${accounts.filter((a) => a.status === "onboarding").length} onboarding`],
      ["YTD orders", money(sum(y, "total")), `${ordersWord(sum(y, "count"))} this year`],
      ["MTD orders", money(sum(m, "total")), `${ordersWord(sum(m, "count"))} in ${new Date().toLocaleDateString("en-US", { month: "long" })}`],
    ]);
    $("book-sub").textContent = hub.auth ? `Accounts owned by ${hub.auth.email}` : "";

    const box = $("my-accounts");
    // Don't redraw under someone typing in a card's form (a sync can land mid-edit).
    if (box.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) {
      pendingRedraw = true;
      return;
    }
    pendingRedraw = false;
    box.replaceChildren(...accounts
      .map((a) => ({ a, y: ytd(a) }))
      .sort((p, q) => q.y.total - p.y.total || p.a.company.localeCompare(q.a.company))
      .map(({ a, y: spend }) => accountCard(a, spend)));
    hub.cards.init(box);
    $("my-accounts-empty").hidden = accounts.length > 0;
  }
  let pendingRedraw = false;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function accountCard(acct, spend) {
    const card = el("section", "xcard account-card");
    card.dataset.card = `acct-${acct.id}`;
    card.dataset.open = "false";
    card.dataset.id = acct.id;

    const head = el("div", "xcard-head");
    const titles = el("div", "xcard-titles");
    titles.append(el("h3", "", acct.company || "Account"));
    titles.append(el("p", "xcard-sub", [[acct.city, acct.state].filter(Boolean).join(", "), acct.status === "onboarding" ? "Onboarding" : ""].filter(Boolean).join(" · ")));
    const m = margin(acct);
    const stats = el("div", "acct-stats");
    const stat = (label, value, cls) => {
      const s = el("div", `acct-stat ${cls || ""}`);
      s.append(el("span", "", label), el("strong", "", value));
      return s;
    };
    stats.append(
      stat("Margin 🔒", m ? pct(m.pct) : "—", m && m.pct < num((state.settings || {}).targetMargin ?? 30) ? "warn" : ""),
      stat("YTD orders", money(spend.total)),
    );
    if ((acct.orders || []).some((o) => orderTotals(o).boLines > 0)) stats.prepend(el("span", "bo-badge", "Back order"));
    head.append(titles, stats);

    const body = el("div", "xcard-body");
    body.append(contactsSection(acct), ordersSection(acct));
    const foot = el("div", "row-buttons acct-foot");
    const open = el("button", "btn small", "Open full account");
    open.type = "button";
    open.addEventListener("click", () => hub.accounts.open(acct.id));
    foot.append(open);
    if (m) foot.append(el("small", "muted", m.from === "orders" ? "Margin from this year's invoiced lines with a cost." : "Margin from the won proposal (no costed orders yet)."));
    body.append(foot);
    card.append(head, body);
    return card;
  }

  // Contacts: the account's primary contact plus any added here.
  function contactsSection(acct) {
    const sec = el("div", "acct-section");
    const h = el("h4", "", "Contacts");
    sec.append(h);
    const list = el("ul", "contact-list");
    const people = [];
    if (acct.contactName || acct.email || acct.phone) {
      people.push({ id: "", name: acct.contactName, title: acct.contactTitle, email: acct.email, phone: acct.phone, primary: true });
    }
    for (const c of acct.contacts || []) people.push(c);
    for (const p of people) {
      const li = el("li", "contact");
      const who = el("div", "contact-who");
      const name = el("strong", "", p.name || "(no name)");
      who.append(name);
      if (p.primary) who.append(el("span", "stage", "Primary"));
      if (p.title) who.append(el("span", "muted", p.title));
      const how = el("div", "contact-how");
      if (p.email) {
        const a = el("a", "", p.email);
        a.href = `mailto:${p.email}`;
        how.append(a);
      }
      if (p.phone) {
        const a = el("a", "", p.phone);
        a.href = `tel:${String(p.phone).replace(/[^\d+]/g, "")}`;
        how.append(a);
      }
      li.append(who, how);
      if (!p.primary) {
        const rm = el("button", "link-btn danger-text", "Remove");
        rm.type = "button";
        rm.setAttribute("aria-label", `Remove ${p.name || "contact"}`);
        rm.addEventListener("click", () => {
          acct.contacts = (acct.contacts || []).filter((c) => c.id !== p.id);
          acct.updated = new Date().toISOString();
          hub.save();
        });
        li.append(rm);
      }
      list.append(li);
    }
    if (!people.length) list.append(el("li", "muted", "No contacts yet."));
    if (acct.otherContacts) list.append(el("li", "muted contact-notes", acct.otherContacts));
    sec.append(list);

    const form = el("form", "contact-add");
    form.innerHTML = `
      <input type="text" name="name" placeholder="Name" aria-label="Contact name" required>
      <input type="text" name="title" placeholder="Title" aria-label="Title">
      <input type="email" name="email" placeholder="Email" aria-label="Email">
      <input type="text" name="phone" placeholder="Phone" aria-label="Phone">
      <button type="submit" class="btn small">Add contact</button>`;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const f = form.elements;
      acct.contacts = [...(acct.contacts || []), {
        id: hub.newId("ct"), name: f.name.value.trim(), title: f.title.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(),
      }];
      acct.updated = new Date().toISOString();
      form.reset();
      document.activeElement && document.activeElement.blur();
      hub.save();
    });
    sec.append(form);
    return sec;
  }

  function ordersSection(acct) {
    const sec = el("div", "acct-section");
    const top = el("div", "acct-section-head");
    const orders = [...(acct.orders || [])].sort(byNewest);
    top.append(el("h4", "", `Orders${orders.length ? ` (${orders.length})` : ""}`));
    const add = el("button", "btn small", "+ Add order");
    add.type = "button";
    add.addEventListener("click", () => openOrder(acct.id, null, true));
    top.append(add);
    sec.append(top);
    if (!orders.length) {
      sec.append(el("p", "hint", "No orders yet. Add one, or import your invoice export with “Import orders” above."));
      return sec;
    }
    const ul = el("ul", "order-list");
    for (const o of orders) {
      const t = orderTotals(o);
      const li = el("li");
      const b = el("button", "order-row");
      b.type = "button";
      b.setAttribute("aria-label", `Invoice ${o.number || ""} ${hub.fmtDate(o.date)}${t.boLines ? ", has back-ordered items" : ""}. Open`);
      const left = el("span", "order-main");
      const title = el("strong", "", o.number ? `Invoice ${o.number}` : o.source === "logged" ? "Logged order" : "Order");
      left.append(title, el("span", "lineup-meta",
        [hub.fmtDate(o.date), o.po ? `PO ${o.po}` : "", `${(o.lines || []).length} line${(o.lines || []).length === 1 ? "" : "s"}`].filter(Boolean).join(" · ")));
      const right = el("span", "order-side");
      if (t.boLines) right.append(el("span", "bo-badge", `Back order · ${t.boUnits} unit${t.boUnits === 1 ? "" : "s"}`));
      right.append(el("span", `stage os-${o.status || "invoiced"}`, STATUSES[o.status] || "Invoiced"), el("strong", "order-total", money(t.total)));
      b.append(left, right);
      b.addEventListener("click", () => openOrder(acct.id, o.id, false));
      li.append(b);
      ul.append(li);
    }
    sec.append(ul);
    return sec;
  }

  // --- Invoice view / edit ---------------------------------------------------

  let current = null; // { acctId, orderId, editing, draft }

  function openOrder(acctId, orderId, editing) {
    const acct = state.accounts.find((a) => a.id === acctId);
    if (!acct) return;
    const order = orderId ? (acct.orders || []).find((o) => o.id === orderId) : null;
    const draft = order ? JSON.parse(JSON.stringify(order)) : {
      id: hub.newId("ord"), number: "", date: hub.today(), po: "", status: "open", tax: 0, freight: 0, notes: "", source: "manual",
      lines: [{ sku: "", name: "", qty: 1, shipped: "", backordered: "", unitPrice: "", cost: "" }],
    };
    current = { acctId, orderId: order ? order.id : null, editing: !!editing, draft };
    $("invoice-modal").hidden = false;
    document.body.classList.add("modal-open");
    renderInvoice();
    setTimeout(() => $("inv-close").focus(), 0);
  }

  function closeOrder() {
    current = null;
    $("invoice-modal").hidden = true;
    document.body.classList.remove("modal-open");
  }

  function renderInvoice() {
    const acct = state.accounts.find((a) => a.id === current.acctId);
    const o = current.draft;
    const t = orderTotals(o);
    $("inv-title").textContent = current.editing ? (current.orderId ? "Edit order" : "New order") : (o.number ? `Invoice ${o.number}` : "Order");
    $("inv-sub").textContent = acct ? acct.company : "";
    const body = $("inv-body");
    body.replaceChildren();
    if (current.editing) return renderEditor(body, o);

    const meta = el("div", "inv-meta");
    for (const [label, value] of [["Date", hub.fmtDate(o.date)], ["PO", o.po || "—"], ["Status", STATUSES[o.status] || "Invoiced"], ["Invoice", o.number || "—"]]) {
      const d = el("div");
      d.append(el("span", "", label), el("strong", "", value));
      meta.append(d);
    }
    body.append(meta);
    if (t.boLines) body.append(el("p", "notice", `${t.boLines} line${t.boLines === 1 ? "" : "s"} on back order (${t.boUnits} unit${t.boUnits === 1 ? "" : "s"}). Back-ordered units are billed when they ship.`));

    const wrap = el("div", "table-wrap");
    const table = el("table", "inv-lines");
    table.innerHTML = "<thead><tr><th>SKU</th><th>Description</th><th class=\"num\">Ordered</th><th class=\"num\">Shipped</th><th class=\"num\">Back order</th><th class=\"num\">Unit price</th><th class=\"num\">Extended</th><th class=\"num internal\">Margin 🔒</th></tr></thead>";
    const tb = el("tbody");
    for (const l of o.lines || []) {
      const bo = backordered(l);
      const ext = billedQty(l) * num(l.unitPrice);
      const m = has(l.cost) && num(l.unitPrice) > 0 ? ((num(l.unitPrice) - num(l.cost)) / num(l.unitPrice)) * 100 : null;
      const tr = el("tr", bo > 0 ? "bo-line" : "");
      const cells = [l.sku || "", l.name || "", num(l.qty), billedQty(l), bo || "", money(l.unitPrice), money(ext), m === null ? "—" : pct(m)];
      cells.forEach((v, i) => {
        const td = el("td", i >= 2 ? "num" : "", String(v));
        if (i === 4 && bo > 0) td.replaceChildren(el("span", "bo-badge", `${bo} on back order`));
        if (i === 7) td.classList.add("internal");
        tr.append(td);
      });
      tb.append(tr);
    }
    table.append(tb);
    wrap.append(table);
    body.append(wrap);

    const totals = el("div", "totals");
    const row = (label, value, cls) => {
      const d = el("div", cls || "");
      d.append(el("span", "", label), el("strong", "", value));
      totals.append(d);
    };
    row("Merchandise", money(t.merch));
    if (num(o.tax)) row("Sales tax", money(o.tax));
    if (num(o.freight)) row("Freight", money(o.freight));
    row("Invoice total", money(t.total), "grand");
    if (t.marginPct !== null) row("Margin (internal)", pct(t.marginPct), "internal");
    body.append(totals);
    if (o.notes) body.append(el("p", "hint", o.notes));

    const actions = el("div", "row-buttons inv-actions");
    const edit = el("button", "btn small primary", "Edit order");
    edit.type = "button";
    edit.addEventListener("click", () => {
      current.editing = true;
      renderInvoice();
    });
    const del = el("button", "btn small danger", "Delete order");
    del.type = "button";
    del.addEventListener("click", () => {
      if (!confirm("Delete this order? It no longer counts toward YTD or MTD.")) return;
      const a = state.accounts.find((x) => x.id === current.acctId);
      const removed = (a.orders || []).find((x) => x.id === current.orderId);
      if (removed) a.replacedOrders = [...(a.replacedOrders || []), { at: new Date().toISOString(), reason: "deleted", order: JSON.parse(JSON.stringify(removed)) }].slice(-25);
      a.orders = (a.orders || []).filter((x) => x.id !== current.orderId);
      for (const act of a.activities || []) if (act.orderId === current.orderId) act.amount = 0;
      a.updated = new Date().toISOString();
      closeOrder();
      hub.save();
    });
    actions.append(edit, del);
    body.append(actions);
  }

  function renderEditor(body, o) {
    const form = el("form", "inv-form");
    form.innerHTML = `
      <div class="grid-form">
        <label>Invoice # <input type="text" name="number"></label>
        <label>Date <input type="date" name="date" required></label>
        <label>PO # <input type="text" name="po"></label>
        <label>Status <select name="status">${Object.entries(STATUSES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Sales tax ($) <input type="number" name="tax" min="0" step="0.01"></label>
        <label>Freight ($) <input type="number" name="freight" min="0" step="0.01"></label>
        <label class="span-2">Notes <input type="text" name="notes"></label>
      </div>
      <div class="table-wrap"><table class="inv-edit">
        <thead><tr><th>SKU</th><th>Description</th><th>Ordered</th><th>Shipped</th><th>Back order</th><th>Unit price</th><th class="internal">Cost 🔒</th><th></th></tr></thead>
        <tbody></tbody></table></div>
      <button type="button" class="btn small" data-add>+ Add line</button>
      <p class="hint">Shipped defaults to the ordered quantity; back order fills in as ordered − shipped. Typing a SKU from your item catalog fills the description and cost.</p>
      <div class="totals inv-edit-totals"></div>
      <p class="status err" data-err></p>
      <div class="row-buttons inv-actions">
        <button type="submit" class="btn green">Save order</button>
        <button type="button" class="btn small" data-cancel>Cancel</button>
      </div>`;
    for (const f of ["number", "date", "po", "status", "tax", "freight", "notes"]) form.elements[f].value = o[f] ?? "";
    const tbody = form.querySelector("tbody");
    const fields = ["sku", "name", "qty", "shipped", "backordered", "unitPrice", "cost"];
    const drawLines = () => {
      tbody.replaceChildren();
      o.lines.forEach((l, i) => {
        const tr = el("tr");
        for (const f of fields) {
          const td = el("td", f === "cost" ? "internal" : "");
          const input = document.createElement("input");
          input.type = ["sku", "name"].includes(f) ? "text" : "number";
          if (input.type === "number") {
            input.min = "0";
            input.step = ["unitPrice", "cost"].includes(f) ? "0.01" : "any";
          }
          if (f === "shipped") input.placeholder = "= ordered";
          if (f === "backordered") input.placeholder = "auto";
          input.value = l[f] ?? "";
          input.dataset.i = i;
          input.dataset.f = f;
          input.setAttribute("aria-label", `Line ${i + 1} ${f}`);
          td.append(input);
          tr.append(td);
        }
        const td = el("td");
        const rm = el("button", "lineup-remove", "×");
        rm.type = "button";
        rm.dataset.rm = i;
        rm.setAttribute("aria-label", `Remove line ${i + 1}`);
        td.append(rm);
        tr.append(td);
        tbody.append(tr);
      });
      drawTotals();
    };
    const drawTotals = () => {
      const t = orderTotals(o);
      const box = form.querySelector(".inv-edit-totals");
      box.replaceChildren();
      for (const [label, value] of [["Merchandise", money(t.merch)], ["Invoice total", money(t.total)], ...(t.marginPct === null ? [] : [["Margin (internal)", pct(t.marginPct)]])]) {
        const d = el("div");
        d.append(el("span", "", label), el("strong", "", value));
        box.append(d);
      }
    };
    form.addEventListener("input", (e) => {
      const { i, f } = e.target.dataset;
      if (f === undefined) {
        o.tax = num(form.elements.tax.value);
        o.freight = num(form.elements.freight.value);
        return drawTotals();
      }
      const line = o.lines[Number(i)];
      const v = e.target.value;
      line[f] = ["sku", "name"].includes(f) ? v : v === "" ? "" : num(v);
      if (f === "sku") {
        const item = hub.catalog && hub.catalog.bySku(v.trim());
        if (item) {
          line.name = line.name || item.name;
          line.cost = item.cost;
          const row = e.target.closest("tr");
          row.querySelector('[data-f="name"]').value = line.name;
          row.querySelector('[data-f="cost"]').value = item.cost;
        }
      }
      if (f === "qty" || f === "shipped") {
        // Keep back order in step unless the rep typed their own.
        if (!line.boManual) {
          line.backordered = has(line.shipped) ? Math.max(0, num(line.qty) - num(line.shipped)) : "";
          e.target.closest("tr").querySelector('[data-f="backordered"]').value = line.backordered;
        }
      }
      if (f === "backordered") line.boManual = v !== "";
      drawTotals();
    });
    form.addEventListener("click", (e) => {
      if (e.target.dataset.rm !== undefined) {
        o.lines.splice(Number(e.target.dataset.rm), 1);
        drawLines();
      } else if (e.target.hasAttribute("data-add")) {
        o.lines.push({ sku: "", name: "", qty: 1, shipped: "", backordered: "", unitPrice: "", cost: "" });
        drawLines();
        tbody.lastElementChild.querySelector("input").focus();
      } else if (e.target.hasAttribute("data-cancel")) {
        if (!current.orderId) closeOrder();
        else {
          current.editing = false;
          current.draft = JSON.parse(JSON.stringify(state.accounts.find((a) => a.id === current.acctId).orders.find((x) => x.id === current.orderId)));
          renderInvoice();
        }
      }
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      for (const f of ["number", "date", "po", "status", "notes"]) o[f] = form.elements[f].value.trim();
      o.tax = num(form.elements.tax.value);
      o.freight = num(form.elements.freight.value);
      o.lines = o.lines.filter((l) => l.sku || l.name || num(l.unitPrice));
      for (const l of o.lines) delete l.boManual;
      if (!o.lines.length) {
        form.querySelector("[data-err]").textContent = "Add at least one line with a description or price.";
        return;
      }
      const acct = state.accounts.find((a) => a.id === current.acctId);
      acct.orders = [...(acct.orders || []).filter((x) => x.id !== o.id), o].sort(byNewest);
      acct.updated = new Date().toISOString();
      current.orderId = o.id;
      current.editing = false;
      current.draft = JSON.parse(JSON.stringify(o));
      hub.save();
      renderInvoice();
    });
    body.append(form);
    drawLines();
  }

  $("inv-close").addEventListener("click", closeOrder);
  $("invoice-modal").addEventListener("click", (e) => {
    if (e.target === $("invoice-modal")) closeOrder();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && current) {
      e.stopImmediatePropagation();
      closeOrder();
    }
  }, true);

  // --- Import an invoice export (CSV / Excel) ---------------------------------

  const ALIASES = {
    invoice: ["invoice", "invoicenumber", "invoiceno", "invoice#", "inv", "invno", "ordernumber", "orderno", "order#", "order"],
    date: ["invoicedate", "date", "orderdate", "shipdate"],
    customerNumber: ["customernumber", "customerno", "customer#", "custno", "cust#", "accountnumber", "account#", "accountno"],
    account: ["customer", "customername", "account", "accountname", "company", "billto", "soldto", "shipto"],
    po: ["po", "ponumber", "po#", "purchaseorder", "customerpo"],
    sku: ["sku", "item", "itemnumber", "item#", "partnumber", "productcode", "itemcode"],
    name: ["description", "itemdescription", "product", "productname", "name"],
    qty: ["qtyordered", "ordered", "orderqty", "qty", "quantity"],
    shipped: ["qtyshipped", "shipped", "shipqty"],
    backordered: ["qtybackordered", "backordered", "backorder", "boqty", "bo"],
    unitPrice: ["unitprice", "price", "sellprice", "unitsell", "netprice"],
    cost: ["unitcost", "cost", "costeach"],
    tax: ["salestax", "tax"],
    freight: ["freight", "shipping", "delivery"],
    status: ["status", "invoicestatus"],
  };
  const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9#]/g, "");
  const nameKey = (s) => String(s || "").toLowerCase().replace(/\b(inc|llc|corp|co|company|ltd)\b|[^a-z0-9]/g, "");

  // An ISO date for a real calendar date, or "" when blank, impossible (13/45/2025) or unrecognized.
  // Slash dates are month/day/year. Rows without a usable date are reported, never dated "today".
  function toIsoDate(v) {
    const s = String(v || "").trim();
    let iso = "";
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) iso = s.slice(0, 10);
    else {
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
      if (m) iso = `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
      else if (/^\d{5}$/.test(s)) iso = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000).toISOString().slice(0, 10); // Excel serial
    }
    return calc.isRealDate(iso) ? iso : "";
  }

  // Reads the file's rows into a PLAN. Nothing is changed until the rep confirms it
  // (applyImport): an invoice export can be partial, and replacing an invoice with
  // fewer lines would quietly lower the account's YTD.
  function planImport(rows) {
    let header = -1, map = null;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const cells = rows[i].map(norm);
      const m = {};
      const used = new Set();
      for (const [field, aliases] of Object.entries(ALIASES)) {
        for (const a of aliases) {
          const idx = cells.findIndex((c, j) => c === a && !used.has(j));
          if (idx >= 0) {
            m[field] = idx;
            used.add(idx);
            break;
          }
        }
      }
      if ((m.account !== undefined || m.customerNumber !== undefined) && m.unitPrice !== undefined && (m.invoice !== undefined || m.date !== undefined)) {
        header = i;
        map = m;
        break;
      }
    }
    if (!map) return { error: "Couldn't find the columns. The file needs a header row with the customer (name or number), invoice number or date, and unit price." };
    const accounts = mine();
    const byNumber = new Map(accounts.filter((a) => a.customerNumber).map((a) => [String(a.customerNumber).trim().toLowerCase(), a]));
    const byName = new Map(accounts.map((a) => [nameKey(a.company), a]));
    const groups = new Map();
    const unmatched = new Set();
    const problems = [];
    let skipped = 0;
    const money2 = (v) => (v === "" ? "" : num(String(v).replace(/[$,]/g, "")));
    rows.slice(header + 1).forEach((r, offset) => {
      const rowNo = header + 2 + offset; // counting the file's non-empty rows, header included
      const get = (f) => (map[f] === undefined ? "" : String(r[map[f]] ?? "").trim());
      if (!r.some((c) => String(c || "").trim())) return;
      const acct = byNumber.get(get("customerNumber").toLowerCase()) || byName.get(nameKey(get("account")));
      if (!acct) {
        unmatched.add(get("account") || get("customerNumber") || "(blank customer)");
        return;
      }
      const date = toIsoDate(get("date"));
      if (!date) {
        problems.push({ row: rowNo, text: get("date") ? "the date isn't a real date (use YYYY-MM-DD or MM/DD/YYYY)" : "there is no date" });
        return;
      }
      const price = money2(get("unitPrice"));
      if (price === "" && !get("sku") && !get("name")) {
        skipped++;
        return;
      }
      const invoice = get("invoice");
      const key = `${acct.id}|${invoice || date}`;
      if (!groups.has(key)) {
        groups.set(key, { acct, rows: [], order: { id: hub.newId("ord"), number: invoice, date, po: get("po"), status: (get("status").toLowerCase() in STATUSES) ? get("status").toLowerCase() : "invoiced", tax: 0, freight: 0, notes: "", source: "import", lines: [] } });
      }
      const g = groups.get(key);
      g.rows.push(rowNo);
      g.order.lines.push({ sku: get("sku"), name: get("name"), qty: num(get("qty") || 1), shipped: money2(get("shipped")), backordered: money2(get("backordered")), unitPrice: price === "" ? 0 : price, cost: money2(get("cost")) });
      // Tax and freight usually repeat on every line of an invoice: keep the largest.
      g.order.tax = Math.max(num(g.order.tax), num(money2(get("tax"))));
      g.order.freight = Math.max(num(g.order.freight), num(money2(get("freight"))));
    });

    const items = [];
    let unchanged = 0;
    for (const g of groups.values()) {
      const { acct, order } = g;
      const sameNumber = (o) => order.number && String(o.number || "").trim().toLowerCase() === order.number.toLowerCase();
      const existing = (acct.orders || []).find(sameNumber) || null;
      const nt = orderTotals(order);
      if (existing) {
        const et = orderTotals(existing);
        const sameContent = et.merch === nt.merch && (existing.lines || []).length === order.lines.length && existing.date === order.date;
        if (sameContent) {
          unchanged++; // re-importing the same file: nothing to do
          continue;
        }
        const shrinks = order.lines.length < (existing.lines || []).length || nt.merch < et.merch;
        items.push({ ...g, kind: "replace", existing, before: { lines: (existing.lines || []).length, merch: et.merch }, after: { lines: order.lines.length, merch: nt.merch }, suspicious: shrinks });
      } else if (!order.number) {
        // No invoice number to match on: treat an identical order on the same date as already imported.
        const twin = (acct.orders || []).find((o) => !o.number && o.date === order.date && orderTotals(o).merch === nt.merch && (o.lines || []).length === order.lines.length);
        if (twin) unchanged++;
        else items.push({ ...g, kind: "add", noNumber: true, after: { lines: order.lines.length, merch: nt.merch } });
      } else {
        items.push({ ...g, kind: "add", after: { lines: order.lines.length, merch: nt.merch } });
      }
    }
    return { items, unmatched: [...unmatched], problems, skipped, unchanged };
  }

  let lastImport = null; // { added: [{acct, id}], replaced: [{acct, previous}] } — undo for this page session

  function applyImport(items) {
    const undo = { added: [], replaced: [] };
    const now = new Date().toISOString();
    for (const it of items) {
      const { acct, order } = it;
      if (it.kind === "replace") {
        // The version being replaced is kept on the account, so it can be recovered later.
        acct.replacedOrders = [...(acct.replacedOrders || []), { at: now, reason: "invoice import", order: JSON.parse(JSON.stringify(it.existing)) }].slice(-25);
        order.id = it.existing.id;
        undo.replaced.push({ acct, previous: JSON.parse(JSON.stringify(it.existing)) });
      } else {
        undo.added.push({ acct, id: order.id });
      }
      acct.orders = [...(acct.orders || []).filter((o) => o.id !== order.id), order].sort(byNewest);
      acct.updated = now;
    }
    lastImport = undo;
    if (items.length) hub.save();
  }

  function undoImport() {
    if (!lastImport) return;
    const now = new Date().toISOString();
    for (const { acct, id } of lastImport.added) {
      acct.orders = (acct.orders || []).filter((o) => o.id !== id);
      acct.updated = now;
    }
    for (const { acct, previous } of lastImport.replaced) {
      acct.orders = [...(acct.orders || []).filter((o) => o.id !== previous.id), previous].sort(byNewest);
      const history = acct.replacedOrders || [];
      const idx = history.map((r) => r.order.id).lastIndexOf(previous.id);
      if (idx >= 0) history.splice(idx, 1); // the entry this import added
      acct.replacedOrders = history;
      acct.updated = now;
    }
    lastImport = null;
    hub.save();
  }

  function renderPlan(report, plan) {
    report.replaceChildren();
    const add = (cls, text) => {
      const p = el("p", cls, text);
      report.append(p);
      return p;
    };
    const adds = plan.items.filter((i) => i.kind === "add");
    const repl = plan.items.filter((i) => i.kind === "replace");
    report.className = "notice";
    add("", `Review before importing: ${adds.length} new order${adds.length === 1 ? "" : "s"}, ${repl.length} existing invoice${repl.length === 1 ? "" : "s"} to update${plan.unchanged ? `, ${plan.unchanged} already up to date` : ""}.`);
    if (plan.skipped) add("hint", `${plan.skipped} blank rows skipped.`);
    if (plan.unmatched.length) add("hint", `No matching account of yours for: ${plan.unmatched.slice(0, 8).join(", ")}${plan.unmatched.length > 8 ? "…" : ""} — those rows are left out. Add the customer number on the account, or check the name.`);
    if (plan.problems.length) {
      add("status err", `${plan.problems.length} row${plan.problems.length === 1 ? " was" : "s were"} left out:`);
      const ul = el("ul", "plain-list");
      for (const pr of plan.problems.slice(0, 10)) ul.append(el("li", "", `Row ${pr.row}: ${pr.text}.`));
      if (plan.problems.length > 10) ul.append(el("li", "", `…and ${plan.problems.length - 10} more.`));
      report.append(ul);
    }
    const noNum = adds.filter((i) => i.noNumber).length;
    if (noNum) add("hint", `${noNum} order${noNum === 1 ? " has" : "s have"} no invoice number, so they can't be matched if you import the same file again; identical ones on the same date are skipped.`);

    const checks = [];
    if (repl.length) {
      add("", "Invoices that will be replaced (the old version is kept on the account):");
      const ul = el("ul", "plain-list");
      for (const it of repl) {
        const li = el("li");
        const label = el("label", "");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = !it.suspicious;
        checks.push([box, it]);
        label.append(box, document.createTextNode(` ${it.acct.company} — invoice ${it.order.number}: ${it.before.lines} line${it.before.lines === 1 ? "" : "s"}, ${money(it.before.merch)} → ${it.after.lines} line${it.after.lines === 1 ? "" : "s"}, ${money(it.after.merch)}`));
        li.append(label);
        if (it.suspicious) li.append(el("div", "status err", "The file has fewer lines or a lower total than what's on the account — it may be a partial export. Left unchecked; tick it only if the file is the complete invoice."));
        ul.append(li);
      }
      report.append(ul);
    }
    const row = el("div", "row-buttons");
    const go = el("button", "btn small primary", "Import");
    const cancel = el("button", "btn small", "Cancel");
    go.type = cancel.type = "button";
    const nothing = !adds.length && !repl.length;
    go.disabled = nothing;
    if (nothing) add("hint", "Nothing to import.");
    go.addEventListener("click", () => {
      const chosen = [...adds, ...checks.filter(([box]) => box.checked).map(([, it]) => it)];
      applyImport(chosen);
      const skippedReplace = repl.length - checks.filter(([box]) => box.checked).length;
      report.replaceChildren();
      report.className = "notice";
      add("", `${chosen.filter((i) => i.kind === "add").length} order(s) added, ${chosen.filter((i) => i.kind === "replace").length} replaced${skippedReplace ? `, ${skippedReplace} left as they were` : ""}.`);
      const undo = el("button", "btn small", "Undo this import");
      undo.type = "button";
      undo.addEventListener("click", () => {
        undoImport();
        report.replaceChildren();
        add("", "Import undone.");
      });
      if (chosen.length) report.append(undo);
      $("orders-file").value = "";
    });
    cancel.addEventListener("click", () => {
      report.replaceChildren();
      report.hidden = true;
      $("orders-file").value = "";
    });
    row.append(go, cancel);
    report.append(row);
  }

  $("orders-import-toggle").addEventListener("click", () => {
    const show = $("orders-import").hidden;
    $("orders-import").hidden = !show;
    $("orders-import-toggle").setAttribute("aria-expanded", String(show));
  });
  $("orders-import-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("orders-file").files[0];
    if (!file) return;
    const report = $("orders-report");
    report.hidden = false;
    report.className = "notice";
    report.textContent = "Reading…";
    try {
      const sheets = await hub.readTableFile(file);
      let plan = { error: "No sheet had the expected columns." };
      for (const s of sheets) {
        plan = planImport(s.rows);
        if (!plan.error) break;
      }
      if (plan.error) {
        report.className = "status err";
        report.textContent = plan.error;
        return;
      }
      renderPlan(report, plan);
    } catch (err) {
      report.className = "status err";
      report.textContent = err.message;
    }
  });

  // --- Wiring ----------------------------------------------------------------

  hub.orders = { orderTotals, ytd, mtd, margin, STATUSES, open: openOrder, toIsoDate, planImport, applyImport };

  let timer = null;
  hub.on(() => {
    if (convertLoggedOrders()) return hub.save(); // re-runs the listeners with the converted data
    clearTimeout(timer);
    timer = setTimeout(renderBook, 60);
  });
  document.addEventListener("focusout", () => {
    if (pendingRedraw) setTimeout(() => !$("my-accounts").contains(document.activeElement) && renderBook(), 0);
  });
  window.addEventListener("saleshub:signedin", renderBook);
  if (convertLoggedOrders()) hub.save();
  renderBook();
})();
