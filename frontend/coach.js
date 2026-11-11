// Coach tab: AI personas that answer from the sales knowledge base (built-in
// playbook, including "Perception matters in sales", plus the rep's own and the
// team's entries). The server grounds each answer in the best-matching entries.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const esc = hub.esc;

  let personas = [];
  let current = null;
  let aiOn = false;
  let history = []; // [{ role, text }] for the current persona
  let loaded = false;

  async function call(path, method, body) {
    const res = await hub.api.fetch(path, {
      method: method || "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // non-JSON body
    }
    if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || `Request failed (${res.status}).`);
    return data;
  }

  // Small, safe formatter: **bold**, "• " / "- " / "1. " lists, paragraphs. Never injects raw HTML.
  function format(text) {
    const lines = String(text).split("\n");
    const out = [];
    let list = null;
    const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    for (const raw of lines) {
      const line = raw.trimEnd();
      const m = line.match(/^\s*(?:[•\-*]|\d+[.)])\s+(.*)$/);
      if (m) {
        if (!list) out.push((list = []));
        list.push(`<li>${inline(m[1])}</li>`);
      } else {
        list = null;
        if (line.trim()) out.push(`<p>${inline(line)}</p>`);
      }
    }
    return out.map((x) => (Array.isArray(x) ? `<ul>${x.join("")}</ul>` : x)).join("");
  }

  async function dealContext() {
    if (!$("coach-use-deal").checked || !hub.deal) return null;
    const r = hub.deal.resolve();
    if (!r) return null;
    const src = r.lead || r.acct;
    // How this buyer likes to be approached, from the rep's own notes (see buyerstyle.js).
    let buyerPersona = "";
    if (r.lead && hub.buyerStyle) {
      try {
        buyerPersona = (await hub.buyerStyle.infer(r.lead)).persona;
      } catch (_) {
        // offline: the coach still works without it
      }
    }
    return {
      buyerPersona,
      company: r.company, segment: src.segment || "", stage: (r.lead && r.lead.stage) || (r.acct && r.acct.status) || "",
      city: src.city || "", state: src.state || "", employees: src.employees || "", products: src.products || [],
      next: r.open ? `proposal ${r.open.status}` : "",
    };
  }

  function addMessage(role, html, extraClass) {
    const div = document.createElement("div");
    div.className = `coach-msg ${role}${extraClass ? " " + extraClass : ""}`;
    div.innerHTML = html;
    $("coach-log").append(div);
    div.scrollIntoView({ block: "end", behavior: "smooth" });
    return div;
  }

  function renderPersonas() {
    const box = $("coach-personas");
    box.replaceChildren();
    for (const p of personas) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "coach-persona";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(current && current.id === p.id));
      b.dataset.id = p.id;
      b.innerHTML = `<span class="cp-icon" aria-hidden="true">${esc(p.icon)}</span><span><strong>${esc(p.name)}</strong><small>${esc(p.blurb)}</small></span>`;
      b.addEventListener("click", () => choose(p.id));
      box.append(b);
    }
  }

  function choose(id) {
    current = personas.find((p) => p.id === id) || personas[0];
    history = [];
    renderPersonas();
    $("coach-log").replaceChildren();
    $("coach-title").textContent = current.name;
    $("coach-blurb").textContent = current.blurb;
    const starters = $("coach-starters");
    starters.replaceChildren(
      ...current.starters.map((s) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn small";
        b.textContent = s;
        b.addEventListener("click", () => {
          $("coach-q").value = s;
          $("coach-form").requestSubmit();
        });
        return b;
      })
    );
    starters.hidden = false;
    try {
      localStorage.setItem("ob.coach.persona", current.id);
    } catch (_) {
      // storage unavailable
    }
  }

  async function ask(e) {
    e.preventDefault();
    const q = $("coach-q").value.trim();
    if (!q || !current) return;
    const btn = $("coach-send");
    btn.disabled = true;
    $("coach-starters").hidden = true;
    addMessage("user", `<p>${esc(q)}</p>`);
    $("coach-q").value = "";
    const pending = addMessage("assistant", "<p class='muted'>Thinking…</p>", "pending");
    try {
      const data = await call("/coach/ask", "POST", { persona: current.id, question: q, history, deal: await dealContext() });
      history.push({ role: "user", text: q }, { role: "assistant", text: data.answer });
      pending.classList.remove("pending");
      pending.innerHTML =
        format(data.answer) +
        `<div class="coach-src">${data.ai ? "" : `<span class="stage warn" title="${aiOn ? "AI is off for you. Turn it on in Account." : "AI writing is off on this server."}">Playbook mode</span> `}` +
        (data.sources.length ? `From: ${data.sources.map((s) => esc(s.title)).join(" · ")}` : "") +
        `</div>`;
      $("coach-copy-last").hidden = false;
      pending.dataset.raw = data.answer;
    } catch (err) {
      pending.classList.remove("pending");
      pending.classList.add("error");
      pending.innerHTML = `<p>${esc(err.message)}</p>`;
    } finally {
      btn.disabled = false;
      $("coach-q").focus();
    }
  }

  // --- Knowledge ---------------------------------------------------------------------------

  async function loadKnowledge() {
    const { entries } = await call("/coach/knowledge");
    const names = Object.fromEntries(personas.map((p) => [p.id, p.name]));
    const list = $("kb-list");
    list.replaceChildren();
    for (const e of entries) {
      const who = e.personas.includes("*") ? "All coaches" : e.personas.map((id) => names[id] || id).join(", ");
      const badge = e.builtin ? "Playbook" : e.shared ? "Team" : "Mine";
      const d = document.createElement("details");
      d.className = "kb-entry";
      d.innerHTML = `<summary><span class="kb-title">${esc(e.title)}</span><span class="stage">${badge}</span><small class="muted">${esc(who)}</small></summary>
        <div class="kb-body">${format(e.body)}</div>
        ${e.builtin || (!e.mine && !(hub.auth && hub.auth.role === "manager")) ? "" : `<button type="button" class="btn small danger" data-del="${esc(e.id)}">Delete</button>`}`;
      list.append(d);
    }
    $("kb-count").textContent = `${entries.length} entries`;
  }

  async function addKnowledge(e) {
    e.preventDefault();
    const status = $("kb-status");
    status.textContent = "";
    status.className = "status";
    const chosen = [...document.querySelectorAll("#kb-personas input:checked")].map((c) => c.value);
    try {
      await call("/coach/knowledge", "POST", {
        title: $("kb-title").value, body: $("kb-body").value, personas: chosen, shared: $("kb-shared").checked,
      });
      $("kb-form").reset();
      status.textContent = "Saved. The coaches will use it from the next question.";
      status.className = "status ok";
      await loadKnowledge();
    } catch (err) {
      status.textContent = err.message;
      status.className = "status err";
    }
  }

  function renderAiNote() {
    const allowed = hub.aiConsent && hub.aiConsent.granted();
    $("coach-ai").textContent = !aiOn
      ? "AI writing is off on this server, so coaches show the matching playbook entries and a checklist. An admin can switch it on with ANTHROPIC_API_KEY."
      : allowed
        ? "Answers are written by AI from your playbook. Your question and a short deal summary (no costs, margins or contacts) are sent to Anthropic. Change this in Account."
        : "AI is off for you, so coaches show the matching playbook entries and a checklist. Turn on AI features in Account to get written answers (your question and a short deal summary go to Anthropic).";
  }
  window.addEventListener("saleshub:aiconsent", renderAiNote);

  async function init() {
    if (loaded) return;
    try {
      const data = await call("/coach/personas");
      personas = data.personas;
      aiOn = data.ai;
    } catch (_) {
      return;
    }
    loaded = true;
    renderAiNote();
    $("kb-personas").innerHTML = personas
      .map((p) => `<label class="check"><input type="checkbox" value="${esc(p.id)}"> ${esc(p.name)}</label>`)
      .join("");
    $("kb-shared-wrap").hidden = !(hub.auth && hub.auth.role === "manager");
    let saved = "";
    try {
      saved = localStorage.getItem("ob.coach.persona") || "";
    } catch (_) {
      // storage unavailable
    }
    choose(saved);
    loadKnowledge().catch(() => {});
  }

  $("coach-form").addEventListener("submit", ask);
  $("coach-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) $("coach-form").requestSubmit();
  });
  $("coach-reset").addEventListener("click", () => current && choose(current.id));
  $("coach-copy-last").addEventListener("click", async () => {
    const last = [...document.querySelectorAll(".coach-msg.assistant[data-raw]")].pop();
    if (!last) return;
    try {
      await navigator.clipboard.writeText(last.dataset.raw);
      $("coach-copy-last").textContent = "Copied";
    } catch (_) {
      $("coach-copy-last").textContent = "Copy failed";
    }
    setTimeout(() => ($("coach-copy-last").textContent = "Copy last answer"), 1500);
  });
  $("kb-form").addEventListener("submit", addKnowledge);
  $("kb-list").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-del]");
    if (!b || !confirm("Delete this knowledge entry?")) return;
    try {
      await call(`/coach/knowledge/${encodeURIComponent(b.dataset.del)}`, "DELETE");
      await loadKnowledge();
    } catch (err) {
      $("kb-status").textContent = err.message;
      $("kb-status").className = "status err";
    }
  });
  window.addEventListener("saleshub:signedin", init);
  window.addEventListener("saleshub:signedout", () => {
    loaded = false;
    personas = [];
    history = [];
    $("coach-log").replaceChildren();
  });
})();
