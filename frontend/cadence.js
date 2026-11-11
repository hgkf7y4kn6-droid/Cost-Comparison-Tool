// Outreach cadence: the follow-up cap. A cold lead gets a first outreach and at most two follow-ups, at least three
// business days apart; after that the lead is flagged so the rep closes the loop instead of chasing. Only
// outreach the rep marks as sent ("I sent this" on the lead) counts. Anything the prospect does (a logged reply,
// a meeting, a visit or a call they took part in) restarts the count, and leads that have moved past "contacted"
// (qualified, proposal sent, won) are not cold any more, so the cap doesn't apply.
(function (root) {
  const MAX_ATTEMPTS = 3; // 1 first outreach + 2 follow-ups
  const MIN_GAP_BUSINESS_DAYS = 3;
  const COLD_STAGES = ["new", "enriched", "verified", "contacted"];
  // Logged as "the prospect engaged": a non-outbound email (their reply), or any meeting/visit/virtual/call.
  const ENGAGED_TYPES = ["email", "meeting", "visit", "virtual", "call"];

  const isoDay = (d) => d.toISOString().slice(0, 10);

  function addBusinessDays(iso, n) {
    const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
    let left = n;
    while (left > 0) {
      d.setUTCDate(d.getUTCDate() + 1);
      const wd = d.getUTCDay();
      if (wd !== 0 && wd !== 6) left--;
    }
    return isoDay(d);
  }

  // Outbound attempts since the prospect last engaged, oldest first.
  function attempts(lead) {
    const acts = [...(lead.activities || [])].sort((a, b) => (a.date || "").localeCompare(b.date || "") || (a.id || "").localeCompare(b.id || ""));
    let run = [];
    for (const a of acts) {
      if (a.outbound) run.push(a);
      else if (ENGAGED_TYPES.includes(a.type)) run = [];
    }
    return run;
  }

  // { state: "none" | "waiting" | "due" | "capped" | "paused" | "not-cold", attempt, followUpsLeft, eligibleOn, last }
  function status(lead, today) {
    if (lead.outreachPaused) return { state: "paused", attempt: 0, followUpsLeft: 0 };
    if (!COLD_STAGES.includes(lead.stage) || (lead.stage !== "contacted" && !(lead.activities || []).some((a) => a.outbound))) {
      return { state: "not-cold", attempt: 0, followUpsLeft: 0 };
    }
    const run = attempts(lead);
    if (!run.length) return { state: "none", attempt: 0, followUpsLeft: MAX_ATTEMPTS - 1 };
    const last = run[run.length - 1].date;
    const eligibleOn = addBusinessDays(last, MIN_GAP_BUSINESS_DAYS);
    if (run.length >= MAX_ATTEMPTS) return { state: "capped", attempt: run.length, followUpsLeft: 0, last };
    return {
      state: eligibleOn <= today ? "due" : "waiting",
      attempt: run.length, followUpsLeft: MAX_ATTEMPTS - run.length, eligibleOn, last,
    };
  }

  const api = { MAX_ATTEMPTS, MIN_GAP_BUSINESS_DAYS, addBusinessDays, attempts, status };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SalesHub.cadence = api;
})(typeof window !== "undefined" ? window : globalThis);
