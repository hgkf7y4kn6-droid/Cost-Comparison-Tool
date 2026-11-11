// Buyer style: infers how a lead likes to be approached (impatient, methodical, frustrated, novice) from the
// rep's own records and drafts outreach in the matching style. The rules live on the server (buyer_persona.py);
// nothing is stored there. Evidence: replies logged as "email" (strongest), the rep's notes and touches, and web
// research pasted into this card.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const esc = hub.esc;

  function signalsFor(lead) {
    const out = [];
    for (const a of lead.activities || []) {
      if (a.text) out.push({ source: a.type === "email" ? "email" : "note", text: a.text, date: a.date });
    }
    if (lead.notes) out.push({ source: "note", text: lead.notes, date: (lead.updated || lead.created || "").slice(0, 10) });
    for (const line of String(lead.research || "").split("\n")) {
      if (line.trim()) out.push({ source: "web", text: line.trim(), date: (lead.updated || "").slice(0, 10) });
    }
    return out;
  }

  async function post(path, body) {
    const res = await hub.api.fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || `Request failed (${res.status}).`);
    return data;
  }

  hub.buyerStyle = { signalsFor, infer: (lead) => post("/persona/infer", { signals: signalsFor(lead) }) };

  const currentLead = () => {
    const id = hub.currentLeadId && hub.currentLeadId();
    return id ? hub.state.leads.find((l) => l.id === id) : null;
  };

  let timer = null;
  let shownFor = "";
  async function refresh() {
    const lead = currentLead();
    if (!lead || $("lead-detail").hidden) return;
    if ($("bs-research") !== document.activeElement) $("bs-research").value = lead.research || "";
    try {
      const r = await hub.buyerStyle.infer(lead);
      if (currentLead() !== lead) return; // moved on to another lead meanwhile
      shownFor = lead.id;
      $("bs-aside").textContent = r.persona === "unknown" ? "" : `${r.confidence}`;
      $("bs-result").innerHTML = r.persona === "unknown"
        ? `<strong>Not enough evidence yet.</strong> ${esc(r.reason)} Log a touch, record their replies, or add web research and this fills in.`
        : `<strong>${esc(r.label)}</strong> <span class="stage">${esc(r.confidence)}</span><br>Suggested style: <strong>${esc(r.style.name)}</strong>`;
      $("bs-evidence").innerHTML = r.evidence
        .map((e) => `<li><span class="stage">${esc(e.source)}</span> “${esc(e.quote)}”${e.date ? ` <small class="muted">${esc(e.date)}</small>` : ""}</li>`)
        .join("");
    } catch (_) {
      $("bs-result").textContent = "Buyer style needs a connection.";
    }
  }
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 300);
  };

  $("bs-research").addEventListener("change", () => {
    const lead = currentLead();
    if (!lead) return;
    lead.research = $("bs-research").value.trim().slice(0, 2000);
    lead.updated = new Date().toISOString();
    hub.save();
  });

  $("bs-draft").addEventListener("click", async () => {
    const lead = currentLead();
    const base = hub.outreachParts && hub.outreachParts();
    if (!lead || !base) return;
    const p = hub.state.profile || {};
    const signature = [p.repName, "Office Basics", p.repPhone].filter(Boolean).join(" · ");
    $("bs-status").textContent = "Drafting…";
    try {
      const d = await post("/persona/draft", { base, signals: signalsFor(lead), signature });
      $("d-draft").value = `Subject: ${d.subject}\n\n${d.body}`;
      $("bs-status").textContent =
        d.persona === "unknown"
          ? `Drafted in the neutral style (${d.words} words): ${d.reason}`
          : `Drafted in the ${d.style} style (${d.words} words, ${d.confidence}). Editing the form above rebuilds the standard draft; press this again to restyle.`;
    } catch (err) {
      $("bs-status").textContent = err.message;
    }
  });

  new MutationObserver(later).observe($("lead-detail"), { attributes: true, attributeFilter: ["hidden"] });
  hub.on(later);
})();
