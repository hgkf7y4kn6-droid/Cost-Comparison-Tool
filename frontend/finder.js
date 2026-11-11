// Find customers: Google Maps discovers local businesses, Apollo adds headcount
// and the buyer. Search runs on the server (keys never reach the browser);
// the rep picks the results to add as leads.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const esc = hub.esc;

  let results = [];
  let status = null; // { google, apollo, areas, segments, defaults, remaining }

  async function call(path, body) {
    const res = await hub.api.fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // non-JSON error body
    }
    if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || `Request failed (${res.status}).`);
    return data;
  }

  function setStatus(text, isError) {
    const el = $("finder-status");
    el.textContent = text || "";
    el.className = "status" + (isError ? " err" : "");
  }

  function fillSelect(select, options) {
    select.replaceChildren(...Object.entries(options).map(([value, label]) => new Option(label, value)));
  }

  function renderAside() {
    if (!status) return;
    $("finder-aside").textContent = status.remaining != null ? `${status.remaining} lookups left today` : "";
  }

  async function loadStatus() {
    try {
      status = await call("/finder/status");
    } catch (_) {
      return; // signed out or offline; try again on the next sign-in
    }
    fillSelect($("finder-segment"), status.segments);
    fillSelect($("finder-area"), status.areas);
    $("finder-min").value = $("finder-min").value || status.defaults.min_employees;
    $("finder-max").value = $("finder-max").value || status.defaults.max_employees;
    const ready = status.google || status.apollo;
    $("finder-setup").hidden = ready;
    $("finder-form").hidden = !ready;
    const sources = [status.google && "Google Maps", status.apollo && "Apollo"].filter(Boolean);
    $("finder-sources").textContent = ready
      ? `Connected: ${sources.join(" + ")}.` + (status.apollo ? "" : " Add an Apollo key to get headcount and buyers.") +
        (status.google ? "" : " Add a Google key to find storefront businesses.")
      : "";
    renderAside();
  }

  function dupOf(r) {
    const lead = hub.findLead(r);
    if (lead) return `Already a lead (${hub.ref.STAGES[lead.stage] || lead.stage})`;
    const key = (x) => `${(x.company || "").toLowerCase().trim()}|${(x.zip || "").slice(0, 5)}`;
    if ([...hub.state.accounts, ...(hub.sharedAccounts || [])].some((a) => key(a) === key(r))) return "Already a customer";
    return "";
  }

  function render() {
    const wrap = $("finder-results");
    wrap.hidden = !results.length;
    const body = $("finder-rows");
    body.replaceChildren();
    results.forEach((r, i) => {
      const dup = dupOf(r);
      const tr = document.createElement("tr");
      const buyer = r.contactName
        ? `<strong>${esc(r.contactName)}</strong><div class="muted">${esc(r.contactTitle || "")}</div>`
        : r.website && status && status.apollo
          ? `<button type="button" class="btn small" data-enrich="${i}">Find buyer</button>`
          : `<span class="muted">—</span>`;
      tr.innerHTML = `
        <td><input type="checkbox" data-pick="${i}" aria-label="Select ${esc(r.company)}" ${dup ? "disabled" : "checked"}></td>
        <td><strong>${esc(r.company)}</strong>
          <div class="muted">${esc([r.address, r.city, r.state].filter(Boolean).join(", "))}</div>
          ${dup ? `<div class="warn small">${esc(dup)}</div>` : ""}</td>
        <td>${r.employees === "" ? '<span class="muted" title="Apollo has no headcount for this company">unknown</span>' : esc(r.employees)}</td>
        <td>${buyer}</td>
        <td>${r.phone ? `<a href="tel:${esc(r.phone.replace(/[^\d+]/g, ""))}">${esc(r.phone)}</a>` : '<span class="muted">—</span>'}</td>
        <td><span class="stage" title="Fit score">${esc(r.fit)}</span></td>`;
      body.append(tr);
    });
    updateCount();
  }

  function picked() {
    return [...document.querySelectorAll("#finder-rows [data-pick]:checked")].map((c) => results[Number(c.dataset.pick)]);
  }

  function updateCount() {
    const n = picked().length;
    $("finder-add").textContent = n ? `Add ${n} as lead${n === 1 ? "" : "s"}` : "Add as leads";
    $("finder-add").disabled = !n;
  }

  async function search(e) {
    e.preventDefault();
    const btn = $("finder-go");
    btn.disabled = true;
    setStatus("Searching… this can take up to 20 seconds.");
    try {
      const data = await call("/finder/search", {
        segment: $("finder-segment").value,
        area: $("finder-area").value,
        min_employees: Number($("finder-min").value),
        max_employees: Number($("finder-max").value),
        limit: 40,
      });
      results = data.results;
      status.remaining = data.remaining;
      renderAside();
      render();
      const notes = (data.notes || []).join(" ");
      setStatus(
        (results.length
          ? `${results.length} companies${data.found > results.length ? ` (best of ${data.found})` : ""}. Unknown headcount means Apollo has no figure: check before you invest time.`
          : "No matches. Try a wider area, another business type or a bigger employee range.") + (notes ? ` ${notes}` : ""),
        !results.length
      );
    } catch (err) {
      results = [];
      render();
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  async function enrichRow(i, button) {
    const r = results[i];
    button.disabled = true;
    button.textContent = "Looking…";
    try {
      const data = await call("/finder/enrich", r);
      const { remaining, ...fields } = data;
      Object.assign(r, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== "" && v != null)));
      status.remaining = remaining;
      renderAside();
      if (!r.contactName) setStatus(`Apollo has no listed buyer for ${r.company}.`);
      else setStatus("");
      render();
    } catch (err) {
      setStatus(err.message, true);
      button.disabled = false;
      button.textContent = "Find buyer";
    }
  }

  function addPicked() {
    const rows = picked();
    const added = hub.addLeads(
      rows.map((r) => ({
        company: r.company, address: r.address, city: r.city, state: r.state, zip: r.zip, industry: r.industry,
        employees: r.employees, website: r.website, phone: r.phone, contactName: r.contactName || "",
        contactTitle: r.contactTitle || "", email: r.email || "", emailStatus: r.emailStatus || "unverified",
        source: r.source || "Customer finder", placeId: r.placeId || "", lat: r.lat ?? "", lng: r.lng ?? "",
        geoQuery: [r.address, r.city, r.state].filter(Boolean).join(", "), geocodedAt: r.lat != null ? new Date().toISOString() : "",
        linkedinUrl: r.linkedinUrl || "",
      }))
    );
    const skipped = rows.length - added.length;
    setStatus(`${added.length} lead${added.length === 1 ? "" : "s"} added to your pipeline${skipped ? ` (${skipped} already there)` : ""}.`);
    render();
  }

  $("finder-form").addEventListener("submit", search);
  $("finder-add").addEventListener("click", addPicked);
  $("finder-all").addEventListener("change", (e) => {
    document.querySelectorAll("#finder-rows [data-pick]:not(:disabled)").forEach((c) => (c.checked = e.target.checked));
    updateCount();
  });
  $("finder-rows").addEventListener("change", updateCount);
  $("finder-rows").addEventListener("click", (e) => {
    const b = e.target.closest("[data-enrich]");
    if (b) enrichRow(Number(b.dataset.enrich), b);
  });
  hub.on(() => results.length && render());
  window.addEventListener("saleshub:signedin", loadStatus);
  window.addEventListener("saleshub:signedout", () => {
    results = [];
    status = null;
    render();
  });

  // "Start here" on Today and the empty state point at this card.
  hub.openFinder = () => {
    window.showTab("prospecting");
    const card = document.querySelector('[data-card="customer-finder"]');
    if (card.classList.contains("collapsed")) card.querySelector(".xcard-head").click();
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const start = $("start-find");
  if (start) start.addEventListener("click", hub.openFinder);
})();
