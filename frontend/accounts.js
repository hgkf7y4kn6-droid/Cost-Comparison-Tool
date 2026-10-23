// Accounts tab: customers created from won quotes (or added by hand). Tracks
// recurring value, savings delivered, product-line coverage and cross-sell
// gaps, an activity log, next actions and renewals.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money } = hub;

  const STATUSES = {
    onboarding: "Onboarding",
    active: "Active",
    "at-risk": "At risk",
    churned: "Churned",
  };

  const ACTIVITY_TYPES = {
    call: "Call",
    email: "Email",
    visit: "Site visit",
    order: "Order",
    issue: "Issue / complaint",
    review: "Business review",
    note: "Note",
  };

  const STALE_DAYS = 60;
  const RENEWAL_WINDOW = 90;

  const findAccount = (id) => state.accounts.find((a) => a.id === id);
  const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);

  // --- Derived figures --------------------------------------------------------

  function quotesFor(acct) {
    return state.quotes.filter((q) => q.accountId === acct.id || (!q.accountId && acct.leadId && q.leadId === acct.leadId));
  }

  function metrics(acct) {
    const won = quotesFor(acct).filter((q) => q.status === "won");
    const m = { recurring: 0, oneTime: 0, savings: 0, lines: new Set(), wonCount: won.length };
    for (const q of won) {
      const t = hub.quotes.totals(q);
      m.recurring += t.recurring;
      m.oneTime += t.oneTime;
      m.savings += Math.max(0, t.savings);
      for (const l of q.lines) if (hub.ref.PRODUCTS[l.type]) m.lines.add(l.type);
    }
    const dates = (acct.activities || []).map((a) => a.date).sort();
    m.lastTouch = dates[dates.length - 1] || "";
    m.stale = acct.status !== "churned" && (!m.lastTouch || daysBetween(m.lastTouch, hub.today()) > STALE_DAYS);
    m.renewalSoon = acct.renewalDate && acct.status !== "churned" &&
      daysBetween(hub.today(), acct.renewalDate) <= RENEWAL_WINDOW;
    m.overdue = acct.nextActionDate && acct.nextActionDate < hub.today();
    return m;
  }

  // --- Create / update ------------------------------------------------------

  function newAccount(fields) {
    const now = new Date().toISOString();
    const acct = {
      id: hub.newId("A"),
      leadId: null,
      company: "",
      address: "", city: "", county: "", state: "", zip: "",
      region: "", segment: "",
      contactName: "", contactTitle: "", email: "", phone: "",
      otherContacts: "",
      status: "onboarding",
      owner: (state.profile || {}).repName || "",
      startDate: hub.today(),
      renewalDate: hub.addDays(hub.today(), 365),
      locations: 1,
      terms: "Net 30",
      notes: "",
      nextAction: "Kickoff / onboarding call",
      nextActionDate: hub.addDays(hub.today(), 3),
      activities: [],
      created: now,
      updated: now,
      ...fields,
    };
    state.accounts.push(acct);
    return acct;
  }

  function log(accountId, type, text, date) {
    const acct = findAccount(accountId);
    if (!acct) return;
    acct.activities = acct.activities || [];
    acct.activities.push({ id: hub.newId("act"), date: date || hub.today(), type, text });
    acct.updated = new Date().toISOString();
  }

  // Called by the Quotes tab when a quote is marked won. Does not save; the
  // caller saves once after all its changes.
  function upsertFromQuote(q) {
    const lead = q.leadId && state.leads.find((l) => l.id === q.leadId);
    let acct = (q.accountId && findAccount(q.accountId)) ||
      (q.leadId && state.accounts.find((a) => a.leadId === q.leadId)) ||
      state.accounts.find((a) => a.company.trim().toLowerCase() === (q.company || "").trim().toLowerCase());
    if (!acct) {
      const src = lead || {};
      acct = newAccount({
        leadId: q.leadId || null,
        company: q.company || src.company || "New account",
        address: src.address || "", city: src.city || "", county: src.county || "",
        state: src.state || "", zip: src.zip || "", region: src.region || "", segment: src.segment || "",
        contactName: q.contactName || src.contactName || "",
        contactTitle: q.contactTitle || src.contactTitle || "",
        email: q.email || src.email || "",
        phone: src.phone || "",
        terms: q.terms || "Net 30",
      });
    } else if (acct.status === "churned") {
      acct.status = "active";
    }
    const t = hub.quotes.totals(q);
    log(acct.id, "order", `Won quote ${q.number}: ${money(t.recurring)}/yr recurring + ${money(t.oneTime)} one-time` +
      (t.savings > 0 ? `, est. ${money(t.savings)}/yr savings for the customer.` : "."));
    return acct;
  }

  // --- List -----------------------------------------------------------------

  let openId = null;
  const form = $("account-form");

  function fillSelect(select, options, keepFirst) {
    const first = keepFirst ? select.options[0] : null;
    select.replaceChildren(...(first ? [first] : []));
    for (const [v, label] of Object.entries(options)) select.append(new Option(label, v));
  }
  fillSelect($("a-f-status"), STATUSES, true);
  fillSelect(form.elements.status, STATUSES);
  fillSelect($("act-type"), ACTIVITY_TYPES);

  function filteredAccounts() {
    const q = $("a-f-search").value.trim().toLowerCase();
    const status = $("a-f-status").value;
    const sort = $("a-f-sort").value;
    const withM = state.accounts.map((a) => ({ a, m: metrics(a) }))
      .filter(({ a, m }) =>
        (!status || (status === "stale" ? m.stale : status === "renewal" ? m.renewalSoon : a.status === status)) &&
        (!q || [a.company, a.city, a.contactName, a.owner].some((v) => (v || "").toLowerCase().includes(q))));
    const cmp = {
      value: (x, y) => y.m.recurring - x.m.recurring,
      company: (x, y) => x.a.company.localeCompare(y.a.company),
      next: (x, y) => (x.a.nextActionDate || "9999").localeCompare(y.a.nextActionDate || "9999"),
      renewal: (x, y) => (x.a.renewalDate || "9999").localeCompare(y.a.renewalDate || "9999"),
    }[sort];
    return withM.sort(cmp);
  }

  function renderKpis() {
    const live = state.accounts.filter((a) => a.status !== "churned");
    const ms = live.map(metrics);
    const sum = (k) => ms.reduce((s, m) => s + m[k], 0);
    const overdue = ms.filter((m) => m.overdue).length;
    const renewals = ms.filter((m) => m.renewalSoon).length;
    const stale = ms.filter((m) => m.stale).length;
    hub.renderTiles($("a-kpis"), [
      ["Active accounts", String(live.length), `${state.accounts.length - live.length} churned`],
      ["Annual recurring value", money(sum("recurring")), `${money(sum("oneTime"))} one-time won`],
      ["Customer savings delivered", money(sum("savings")), "per year, from won quotes"],
      ["Follow-ups overdue", String(overdue), `${stale} with no touch in ${STALE_DAYS}+ days`],
      ["Renewals ≤ 90 days", String(renewals), "review pricing & expand"],
    ]);
  }

  function renderFollowUps() {
    const horizon = hub.addDays(hub.today(), 7);
    const due = state.accounts
      .filter((a) => a.status !== "churned" && a.nextActionDate && a.nextActionDate <= horizon)
      .sort((a, b) => a.nextActionDate.localeCompare(b.nextActionDate));
    const ul = $("a-followups");
    ul.replaceChildren();
    for (const a of due) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "link-btn";
      btn.textContent = a.company;
      btn.addEventListener("click", () => openAccount(a.id));
      const when = document.createElement("span");
      const late = a.nextActionDate < hub.today();
      when.className = late ? "warn" : "muted";
      when.textContent = late ? `overdue since ${hub.fmtDate(a.nextActionDate)}` : hub.fmtDate(a.nextActionDate);
      li.append(when, " — ", btn, `: ${a.nextAction || "follow up"}`);
      ul.append(li);
    }
    $("a-followups-wrap").hidden = !due.length;
  }

  function renderList() {
    const list = filteredAccounts();
    const tbody = $("a-rows");
    tbody.replaceChildren();
    const short = { furniture: "Furniture", janitorial: "Janitorial", apparel: "Apparel" };
    for (const { a, m } of list) {
      const tr = document.createElement("tr");
      tr.dataset.id = a.id;
      tr.tabIndex = 0;
      if (a.id === openId) tr.className = "selected";
      const cells = [
        [a.company, [a.city, a.state].filter(Boolean).join(", ")],
        [(hub.ref.REGIONS || {})[a.region] || ""],
        null,
        [[...m.lines].map((l) => short[l]).join(" · ") || "—"],
        [money(m.recurring), m.oneTime ? `+ ${money(m.oneTime)} one-time` : "", "num"],
        [m.lastTouch ? hub.fmtDate(m.lastTouch) : "never", m.stale ? `${STALE_DAYS}+ days` : "", m.stale ? "warn" : ""],
        [a.nextActionDate ? hub.fmtDate(a.nextActionDate) : "—", a.nextAction, m.overdue ? "warn" : ""],
        [a.renewalDate ? hub.fmtDate(a.renewalDate) : "—", m.renewalSoon ? "renewal soon" : "", m.renewalSoon ? "warn" : ""],
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        if (!c) {
          const s = document.createElement("span");
          s.className = `stage as-${a.status}`;
          s.textContent = STATUSES[a.status];
          td.append(s);
        } else {
          const [text, sub, cls] = c;
          const span = document.createElement("span");
          span.textContent = text;
          if (cls === "warn") span.className = "warn";
          if (cls === "num") td.className = "num";
          td.append(span);
          if (sub) {
            const d = document.createElement("div");
            d.className = "sub";
            d.textContent = sub;
            td.append(d);
          }
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    $("a-count").textContent = `${list.length} of ${state.accounts.length} accounts`;
    $("a-empty").hidden = state.accounts.length > 0;
  }

  function renderAll() {
    renderKpis();
    renderFollowUps();
    renderList();
    if (openId) renderDetailExtras();
  }

  ["a-f-search", "a-f-status", "a-f-sort"].forEach((id) => $(id).addEventListener("input", renderList));
  $("a-rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openAccount(tr.dataset.id);
  });
  $("a-rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openAccount(tr.dataset.id);
    }
  });

  $("a-new").addEventListener("click", () => {
    const acct = newAccount({ company: "New account" });
    hub.save();
    openAccount(acct.id);
    form.elements.company.select();
  });

  $("a-export").addEventListener("click", () => {
    const rows = filteredAccounts().map(({ a, m }) => [
      a.company, a.address, a.city, a.state, a.zip, (hub.ref.REGIONS || {})[a.region] || "",
      STATUSES[a.status], a.owner, a.contactName, a.contactTitle, a.email, a.phone,
      [...m.lines].map((l) => hub.ref.PRODUCTS[l].label).join("; "),
      m.recurring.toFixed(2), m.oneTime.toFixed(2), m.savings.toFixed(2),
      a.startDate, a.renewalDate, m.lastTouch, a.nextAction, a.nextActionDate, a.locations, a.terms, a.notes,
    ]);
    hub.downloadCsv(`accounts-${hub.today()}.csv`,
      ["company", "address", "city", "state", "zip", "region", "status", "owner", "contact_name", "contact_title",
        "email", "phone", "product_lines", "annual_recurring", "one_time", "annual_savings_delivered",
        "start_date", "renewal_date", "last_touch", "next_action", "next_action_date", "locations", "terms", "notes"],
      rows);
  });

  // --- Detail ---------------------------------------------------------------

  const FIELDS = ["company", "status", "owner", "contactName", "contactTitle", "email", "phone", "address",
    "city", "state", "zip", "locations", "terms", "startDate", "renewalDate", "nextAction", "nextActionDate",
    "otherContacts", "notes"];

  function openAccount(id) {
    const acct = findAccount(id);
    if (!acct) return;
    window.showTab("accounts");
    openId = id;
    for (const f of FIELDS) form.elements[f].value = acct[f] ?? "";
    $("ad-title").textContent = acct.company;
    $("ad-status").textContent = "";
    $("act-date").value = hub.today();
    $("act-text").value = "";
    $("account-detail").hidden = false;
    renderDetailExtras();
    renderList();
  }

  function closeAccount() {
    openId = null;
    $("account-detail").hidden = true;
    renderList();
  }

  function renderDetailExtras() {
    const acct = findAccount(openId);
    if (!acct) {
      closeAccount();
      return;
    }
    const m = metrics(acct);
    $("ad-lead-link").hidden = !acct.leadId;

    hub.renderTiles($("ad-kpis"), [
      ["Annual recurring", money(m.recurring), `${m.wonCount} won quote${m.wonCount === 1 ? "" : "s"}`],
      ["One-time won", money(m.oneTime), ""],
      ["Savings delivered", money(m.savings), "per year"],
      ["Last touch", m.lastTouch ? hub.fmtDate(m.lastTouch) : "never", m.stale ? `over ${STALE_DAYS} days — check in` : ""],
    ]);

    // Product-line coverage and cross-sell gaps
    const cov = $("ad-coverage");
    cov.replaceChildren();
    for (const [key, p] of Object.entries(hub.ref.PRODUCTS)) {
      const div = document.createElement("div");
      const has = m.lines.has(key);
      div.className = `coverage ${has ? "has" : "gap"}`;
      const title = document.createElement("strong");
      title.textContent = `${has ? "✓" : "○"} ${p.label}`;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = has ? "Buying today" : `Cross-sell — talk to: ${p.titles.join(" · ")}`;
      div.append(title, sub);
      if (!has) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn small";
        b.textContent = "Quote it";
        b.addEventListener("click", () => hub.quotes.newForAccount(acct.id));
        div.append(b);
      }
      cov.append(div);
    }

    // Linked quotes
    const qs = quotesFor(acct).sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    const ql = $("ad-quotes");
    ql.replaceChildren();
    for (const q of qs) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link-btn";
      b.textContent = q.number;
      b.addEventListener("click", () => hub.quotes.open(q.id));
      const t = hub.quotes.totals(q);
      const status = hub.quotes.isExpired(q) ? "Expired" : hub.quotes.STATUSES[q.status];
      li.append(b, ` — ${status} · ${money(t.recurring)}/yr recurring · ${money(t.oneTime)} one-time`);
      ql.append(li);
    }
    $("ad-no-quotes").hidden = qs.length > 0;

    // Activity timeline, newest first
    const tl = $("ad-activity");
    tl.replaceChildren();
    const acts = [...(acct.activities || [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    for (const a of acts) {
      const li = document.createElement("li");
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = `${hub.fmtDate(a.date)} · ${ACTIVITY_TYPES[a.type] || a.type}`;
      const text = document.createElement("div");
      text.textContent = a.text;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link-btn danger-text";
      del.textContent = "remove";
      del.addEventListener("click", () => {
        acct.activities = acct.activities.filter((x) => x.id !== a.id);
        hub.save();
      });
      when.append(" ", del);
      li.append(when, text);
      tl.append(li);
    }
    $("ad-no-activity").hidden = acts.length > 0;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const acct = findAccount(openId);
    if (!acct) return;
    for (const f of FIELDS) acct[f] = form.elements[f].value.trim();
    acct.state = acct.state.toUpperCase();
    acct.locations = Number(acct.locations) || 1;
    if (!acct.region && hub.ref.regionFor) acct.region = hub.ref.regionFor(acct);
    acct.updated = new Date().toISOString();
    hub.save();
    $("ad-title").textContent = acct.company;
    $("ad-status").textContent = "Saved.";
  });

  $("act-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("act-text").value.trim();
    if (!openId || !text) return;
    log(openId, $("act-type").value, text, $("act-date").value || hub.today());
    const acct = findAccount(openId);
    const next = $("act-next").value.trim();
    if (next) {
      acct.nextAction = next;
      acct.nextActionDate = $("act-next-date").value || hub.addDays(hub.today(), 7);
      form.elements.nextAction.value = acct.nextAction;
      form.elements.nextActionDate.value = acct.nextActionDate;
    }
    $("act-text").value = "";
    $("act-next").value = "";
    $("act-next-date").value = "";
    hub.save();
  });

  $("ad-new-quote").addEventListener("click", () => openId && hub.quotes.newForAccount(openId));
  $("ad-lead-link").addEventListener("click", () => {
    const acct = findAccount(openId);
    if (acct && acct.leadId) hub.openLead(acct.leadId);
  });
  $("ad-close").addEventListener("click", closeAccount);
  $("ad-delete").addEventListener("click", () => {
    const acct = findAccount(openId);
    if (!acct || !confirm(`Delete account ${acct.company}? Its quotes are kept.`)) return;
    state.accounts = state.accounts.filter((a) => a.id !== openId);
    for (const q of state.quotes) if (q.accountId === acct.id) q.accountId = null;
    closeAccount();
    hub.save();
  });

  hub.accounts = {
    upsertFromQuote,
    log,
    open: openAccount,
  };

  hub.on(renderAll);
  renderAll();
})();
