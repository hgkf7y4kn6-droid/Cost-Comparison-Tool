// Today tab: everything that needs a rep's attention, across all stages, with
// a button that opens the right record. Built from the shared store, so it
// refreshes whenever another tab changes something.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money } = hub;

  const MAX_ITEMS = 6;
  const STALE_DAYS = 60;
  const daysBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a.slice(0, 10)}T12:00:00`)) / 86400000);
  const ago = (iso) => {
    const d = daysBetween(iso, hub.today());
    return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`;
  };

  function lastTouch(acct) {
    return (acct.activities || []).map((a) => a.date).sort().pop() || "";
  }

  // item: { title, detail, tone ("late" | "soon" | ""), actions: [[label, fn, primary?]] }
  // An expandable card (cards.js): title + subtitle, item count on the right.
  // Cards with items start open; the rep's open/closed choice is remembered.
  function card(id, title, subtitle, items, emptyText) {
    const outer = document.createElement("section");
    outer.className = "xcard today-card";
    outer.dataset.card = `today-${id}`;
    outer.dataset.open = items.length ? "true" : "false";
    const head = document.createElement("div");
    head.className = "xcard-head";
    const titles = document.createElement("div");
    titles.className = "xcard-titles";
    const h = document.createElement("h3");
    h.textContent = title;
    titles.append(h);
    if (subtitle) {
      const p = document.createElement("p");
      p.className = "xcard-sub";
      p.textContent = subtitle;
      titles.append(p);
    }
    const count = document.createElement("span");
    count.className = `xcard-aside count${items.length ? " has" : ""}`;
    count.textContent = items.length;
    head.append(titles, count);
    const sec = document.createElement("div");
    sec.className = "xcard-body";
    outer.append(head, sec);
    if (!items.length) {
      const p = document.createElement("p");
      p.className = "today-empty";
      p.textContent = emptyText;
      sec.append(p);
      return outer;
    }
    const ul = document.createElement("ul");
    ul.className = "today-list";
    for (const it of items.slice(0, MAX_ITEMS)) {
      const li = document.createElement("li");
      if (it.tone) li.className = it.tone;
      const text = document.createElement("div");
      text.className = "today-text";
      const t = document.createElement("strong");
      t.textContent = it.title;
      const d = document.createElement("span");
      d.textContent = it.detail;
      text.append(t, d);
      const btns = document.createElement("div");
      btns.className = "today-actions";
      for (const [label, fn, primary] of it.actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = primary ? "btn small primary" : "btn small";
        b.textContent = label;
        b.addEventListener("click", fn);
        btns.append(b);
      }
      li.append(text, btns);
      ul.append(li);
    }
    sec.append(ul);
    if (items.length > MAX_ITEMS) {
      const more = document.createElement("p");
      more.className = "hint";
      more.textContent = `+ ${items.length - MAX_ITEMS} more`;
      sec.append(more);
    }
    return outer;
  }

  const work = (kind, id, then) => () => {
    hub.deal.set(kind, id);
    then();
  };

  function render() {
    const today = hub.today();
    const week = hub.addDays(today, 7);
    $("today-date").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });

    const liveAccounts = state.accounts.filter((a) => a.status !== "churned");
    const openQuotes = state.quotes.filter((q) => ["sent", "negotiating"].includes(q.status));
    const quotedLeads = new Set(state.quotes.map((q) => q.leadId).filter(Boolean));

    // Follow-ups: account next actions due within a week, overdue first.
    const followUps = liveAccounts
      .filter((a) => a.nextActionDate && a.nextActionDate <= week)
      .sort((a, b) => a.nextActionDate.localeCompare(b.nextActionDate))
      .map((a) => {
        const late = a.nextActionDate < today;
        return {
          title: a.company,
          detail: `${a.nextAction || "Follow up"} — ${late ? `overdue since ${hub.fmtDate(a.nextActionDate)}` : a.nextActionDate === today ? "due today" : `due ${hub.fmtDate(a.nextActionDate)}`}`,
          tone: late ? "late" : a.nextActionDate === today ? "soon" : "",
          actions: [[a.status === "onboarding" ? "Onboarding" : "Open account",
            work("account", a.id, () => hub.accounts.open(a.id, { focus: a.status === "onboarding" ? "onboarding" : "" })), true]],
        };
      });

    // Proposals out with the customer: expired, expiring, or quiet for a week.
    const waiting = openQuotes
      .map((q) => {
        const t = hub.quotes.totals(q);
        const expired = hub.quotes.isExpired(q);
        const sentDays = q.sentDate ? daysBetween(q.sentDate, today) : 0;
        const until = hub.addDays((q.sentDate || q.created).slice(0, 10), q.validDays || 30);
        const expiring = !expired && until <= week;
        const kind = q.accountId ? "account" : "lead";
        const id = q.accountId || q.leadId;
        return {
          sort: expired ? 0 : expiring ? 1 : 2 - Math.min(sentDays, 999) / 1000,
          title: `${q.company || "(no customer)"} — ${q.number}`,
          detail: `${money(t.firstYear)} first year · sent ${q.sentDate ? ago(q.sentDate) : "—"} · ${expired ? "expired" : `valid until ${hub.fmtDate(until)}`}`,
          tone: expired ? "late" : expiring || sentDays >= 7 ? "soon" : "",
          actions: [["Open quote", id ? work(kind, id, () => hub.quotes.open(q.id)) : () => hub.quotes.open(q.id), true]],
        };
      })
      .sort((a, b) => a.sort - b.sort);

    const drafts = state.quotes
      .filter((q) => q.status === "draft")
      .sort((a, b) => (a.updated || "").localeCompare(b.updated || ""))
      .map((q) => ({
        title: `${q.company || "(no customer)"} — ${q.number}`,
        detail: `${q.lines.length} line${q.lines.length === 1 ? "" : "s"} · last edited ${ago(q.updated || q.created)}`,
        tone: daysBetween(q.updated || q.created, today) >= 3 ? "soon" : "",
        actions: [["Finish quote", () => {
          if (q.accountId) hub.deal.set("account", q.accountId);
          else if (q.leadId) hub.deal.set("lead", q.leadId);
          hub.quotes.open(q.id);
        }, true]],
      }));

    // Qualified/contacted leads with no quote yet.
    const toQuote = state.leads
      .filter((l) => ["contacted", "qualified"].includes(l.stage) && !quotedLeads.has(l.id))
      .sort((a, b) => b.score - a.score)
      .map((l) => ({
        title: l.company,
        detail: `${hub.ref.STAGES[l.stage]} · fit ${l.score}${l.contactName ? ` · ${l.contactName}` : ""}`,
        tone: "",
        actions: [
          ["Run comparison", work("lead", l.id, () => window.showTab("compare")), true],
          ["New quote", work("lead", l.id, () => hub.quotes.newForLead(l.id))],
        ],
      }));

    // Best-fit leads not yet contacted.
    const outreach = state.leads
      .filter((l) => ["new", "enriched", "verified"].includes(l.stage) && l.region !== "other")
      .sort((a, b) => (b.stage === "verified") - (a.stage === "verified") || b.score - a.score)
      .map((l) => ({
        title: l.company,
        detail: `${hub.ref.STAGES[l.stage]} · fit ${l.score} · ${hub.ref.REGIONS[l.region] || ""}${l.stage === "verified" ? " · email verified" : ""}`,
        tone: "",
        actions: [["Open lead", work("lead", l.id, () => hub.openLead(l.id)), true]],
      }));

    // Accounts needing attention: renewals within 90 days, or no touch in 60+.
    const care = liveAccounts
      .map((a) => {
        const renewalDays = a.renewalDate ? daysBetween(today, a.renewalDate) : null;
        const touch = lastTouch(a);
        const stale = !touch || daysBetween(touch, today) > STALE_DAYS;
        const renewal = renewalDays !== null && renewalDays <= 90;
        if (!renewal && !stale) return null;
        return {
          sort: renewal ? renewalDays : 1000,
          title: a.company,
          detail: [renewal ? `renewal ${renewalDays < 0 ? "passed" : `in ${renewalDays} days`}` : "",
            stale ? (touch ? `no touch since ${hub.fmtDate(touch)}` : "no activity logged") : ""].filter(Boolean).join(" · "),
          tone: renewal && renewalDays <= 30 ? "late" : "soon",
          actions: [["Open account", work("account", a.id, () => hub.accounts.open(a.id)), true]],
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.sort - b.sort);

    const overdue = followUps.filter((f) => f.tone === "late").length;
    hub.renderTiles($("today-kpis"), [
      ["Follow-ups due this week", String(followUps.length), overdue ? `${overdue} overdue` : "none overdue"],
      ["Proposals out", String(waiting.length), money(openQuotes.reduce((s, q) => s + hub.quotes.totals(q).firstYear, 0)) + " first-year value"],
      ["Ready to quote", String(toQuote.length), "contacted / qualified, no quote yet"],
      ["Accounts needing care", String(care.length), "renewals ≤ 90 days or quiet 60+ days"],
    ]);

    const grid = $("today-grid");
    grid.replaceChildren(
      card("followups", "Follow-ups", "Next actions on your accounts, due within a week.", followUps, "Nothing due this week."),
      card("proposals", "Proposals waiting on the customer", "Expired and expiring first, then the ones gone quiet.", waiting, "No proposals out right now."),
      card("ready", "Ready to quote", "Leads you've talked to that don't have a quote yet.", toQuote, "Every engaged lead has a quote."),
      card("drafts", "Drafts to finish", "Quotes not sent yet, oldest first.", drafts, "No drafts waiting."),
      card("outreach", "Leads to reach out to", "Best fit first; verified emails at the top.", outreach, "No new leads — import a list on the Prospecting tab."),
      card("care", "Accounts needing care", "Upcoming renewals and accounts you haven't touched lately.", care, "All accounts are in good shape."),
    );
    hub.cards.init(grid);

    const empty = !state.leads.length && !state.quotes.length && !state.accounts.length;
    $("today-start").hidden = !empty;
  }

  $("start-import").addEventListener("click", () => {
    window.showTab("prospecting");
    $("lead-file").focus();
  });
  $("start-margin").addEventListener("click", () => {
    window.showTab("quotes");
    hub.cards.open($("m-target"));
    $("m-target").focus();
  });
  $("start-profile").addEventListener("click", () => {
    window.showTab("quotes");
    hub.cards.open($("rep-profile"));
    $("rep-profile").elements.repName.focus();
  });

  hub.on(render);
  window.addEventListener("hashchange", () => location.hash === "#today" && render());
  render();
})();
