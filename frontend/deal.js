// The "current deal": the customer a rep is working on, shown in a bar on every
// tab with the one next step that moves it forward. A deal is a lead or an
// account (state.activeDeal = { kind, id }); state.activeLeadId is kept in step
// for the parts of the app that hand a lead between tabs.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money } = hub;

  const OPEN = ["draft", "sent", "negotiating"];
  const EARLY = ["new", "enriched", "verified", "contacted"];

  if (!state.activeDeal && state.activeLeadId) state.activeDeal = { kind: "lead", id: state.activeLeadId };

  const findLead = (id) => state.leads.find((l) => l.id === id);
  const findAccount = (id) => state.accounts.find((a) => a.id === id);
  const daysSince = (iso) => Math.round((Date.now() - new Date(`${iso.slice(0, 10)}T12:00:00`)) / 86400000);
  const dealKey = (d) => (d ? `${d.kind}:${d.id}` : "");

  function resolve(deal = state.activeDeal) {
    if (!deal) return null;
    let lead = null, acct = null;
    if (deal.kind === "account") {
      acct = findAccount(deal.id);
      lead = acct && acct.leadId ? findLead(acct.leadId) : null;
    } else {
      lead = findLead(deal.id);
      acct = lead ? state.accounts.find((a) => a.leadId === lead.id) || null : null;
    }
    if (!lead && !acct) return null;
    const quotes = state.quotes
      .filter((q) => (acct && q.accountId === acct.id) || (lead && q.leadId === lead.id))
      .sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    return {
      lead, acct, quotes,
      open: quotes.find((q) => OPEN.includes(q.status)) || null,
      company: (acct || lead).company,
    };
  }

  function set(kind, id) {
    const deal = kind && id ? { kind, id } : null;
    const r = resolve(deal);
    state.activeDeal = r ? deal : null;
    state.activeLeadId = r && r.lead ? r.lead.id : null;
    hub.save();
  }

  // The single most useful next action for the deal, in sales-cycle order.
  function nextStep(r) {
    const openLead = () => hub.openLead(r.lead.id);
    const openAcct = () => hub.accounts.open(r.acct.id);
    const q = r.open;
    if (q) {
      if (q.status === "draft") {
        return { label: "Finish & send proposal", hint: `${q.number} · ${q.lines.length} line${q.lines.length === 1 ? "" : "s"} · ${money(hub.quotes.totals(q).firstYear)} first year`, run: () => hub.quotes.open(q.id) };
      }
      if (hub.quotes.isExpired(q)) {
        return { label: "Proposal expired — re-quote", hint: `${q.number} passed its valid-until date`, run: () => hub.quotes.open(q.id), urgent: true };
      }
      const days = q.sentDate ? daysSince(q.sentDate) : 0;
      return { label: "Follow up on proposal", hint: `${q.number} sent ${days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}`, run: () => hub.quotes.open(q.id), urgent: days >= 7 };
    }
    if (r.acct && r.acct.status === "onboarding") {
      const { done, total } = hub.accounts.onboardingProgress(r.acct);
      return { label: "Customer Onboarding", hint: `${done} of ${total} steps done`, run: () => hub.accounts.open(r.acct.id, { focus: "onboarding" }) };
    }
    if (r.acct) {
      const due = r.acct.nextActionDate;
      const late = due && due < hub.today();
      return {
        label: r.acct.nextAction || "Log the next touch",
        hint: due ? `${late ? "overdue since" : "due"} ${hub.fmtDate(due)}` : "no next action set",
        run: openAcct,
        urgent: late,
      };
    }
    const lead = r.lead;
    const last = r.quotes[0];
    if (last && last.status === "lost") return { label: "Re-engage", hint: `${last.number} lost${last.lossReason ? ` (${last.lossReason})` : ""}`, run: openLead };
    if (lead.stage === "disqualified") return { label: "Review lead", hint: "marked disqualified", run: openLead };
    if (EARLY.slice(0, 2).includes(lead.stage)) {
      return lead.contactName
        ? { label: "Verify email & reach out", hint: "run it through ZeroBounce/NeverBounce, then use the outreach draft", run: openLead }
        : { label: "Find the decision-maker", hint: "enrich in Clay/Apollo, then add the contact", run: openLead };
    }
    if (lead.stage === "verified") return { label: "Send outreach", hint: "the lead panel has a draft email", run: openLead };
    const compared = state.lastComparison && state.lastComparison.forDeal === dealKey(state.activeDeal);
    if (compared) {
      return { label: "Build quote", hint: `from your comparison of ${state.lastComparison.competitor_product || "their current product"}`, run: () => hub.quotes.newForLead(lead.id) };
    }
    return { label: "Run a cost comparison", hint: "upload what they buy today", run: () => window.showTab("compare") };
  }

  function stageText(r) {
    if (r.open) return hub.quotes.isExpired(r.open) ? "Quote expired" : `Quote ${hub.quotes.STATUSES[r.open.status].toLowerCase()}`;
    if (r.acct) return "Account";
    return hub.ref.STAGES[r.lead.stage] || "";
  }

  // --- Bar ------------------------------------------------------------------

  function fillSwitch(current) {
    const sel = $("deal-switch");
    sel.replaceChildren(new Option(current ? "Switch deal…" : "Pick a deal to work on…", ""));
    const groups = [
      ["Open quotes", state.quotes.filter((q) => OPEN.includes(q.status))
        .map((q) => (q.accountId ? ["account", q.accountId, `${q.company} — ${q.number}`] : q.leadId ? ["lead", q.leadId, `${q.company} — ${q.number}`] : null))],
      // Engaged leads first, then the best-fit new ones.
      ["Leads", state.leads.filter((l) => !["won", "disqualified"].includes(l.stage))
        .sort((a, b) => (EARLY.slice(0, 3).includes(a.stage) - EARLY.slice(0, 3).includes(b.stage)) || b.score - a.score)
        .slice(0, 40).map((l) => ["lead", l.id, `${l.company} — ${hub.ref.STAGES[l.stage]}`])],
      ["Accounts", state.accounts.filter((a) => a.status !== "churned")
        .sort((a, b) => a.company.localeCompare(b.company)).map((a) => ["account", a.id, a.company])],
    ];
    const seen = new Set([current]);
    for (const [label, items] of groups) {
      const g = document.createElement("optgroup");
      g.label = label;
      for (const item of items) {
        if (!item) continue;
        const key = `${item[0]}:${item[1]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        g.append(new Option(item[2], key));
      }
      if (g.children.length) sel.append(g);
    }
    sel.value = "";
  }

  let step = null;

  function render() {
    const r = resolve();
    const key = r ? dealKey(state.activeDeal) : "";
    if (!r && state.activeDeal) state.activeDeal = null; // record was deleted
    $("deal-active").hidden = !r;
    $("deal-none").hidden = !!r;
    fillSwitch(key);
    if (!r) return;
    $("deal-name").textContent = r.company;
    $("deal-stage").textContent = stageText(r);
    step = nextStep(r);
    $("deal-next").textContent = `${step.label} →`;
    $("deal-next").classList.toggle("urgent", !!step.urgent);
    $("deal-hint").textContent = step.hint || "";
  }

  $("deal-next").addEventListener("click", () => step && step.run());
  $("deal-name").addEventListener("click", () => {
    const r = resolve();
    if (!r) return;
    if (r.open) hub.quotes.open(r.open.id);
    else if (r.acct) hub.accounts.open(r.acct.id);
    else hub.openLead(r.lead.id);
  });
  $("deal-switch").addEventListener("change", (e) => {
    const [kind, id] = e.target.value.split(":");
    if (kind) set(kind, id);
  });
  $("deal-clear").addEventListener("click", () => set(null));

  hub.deal = { set, resolve, nextStep, key: () => dealKey(state.activeDeal) };
  hub.on(render);
  render();
})();
