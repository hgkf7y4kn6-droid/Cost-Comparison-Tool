// Business card scanning: take a photo, the server reads it (POST /cards/scan:
// AI vision when configured, otherwise OCR + rules), and the rep checks the
// fields before anything is saved. Saves a lead (prospect) or an account, or adds
// the contact to a matching record the rep already has. The photo is never stored.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;

  const form = $("cs-form");
  const FIELDS = ["name", "title", "email", "phone", "mobile", "website", "company", "address", "city", "state", "zip", "met"];
  const MAX_SIDE = 1600;
  const val = (n) => form.elements[n].value.trim();

  let previewUrl = "";
  let existing = null; // { kind, id, company } the card seems to match
  let opener = null;
  let busy = false;

  const say = (message, tone = "") => {
    $("cs-status").textContent = message;
    $("cs-status").className = `status ${tone}`;
  };

  // --- Dialog ------------------------------------------------------------------

  const isOpen = () => !$("cardscan").hidden;

  function showStep(step) {
    $("cs-capture").hidden = step !== "capture";
    $("cs-reading").hidden = step !== "reading";
    $("cs-verify").hidden = step !== "verify";
  }

  function resetDialog() {
    form.reset();
    $("cs-file").value = "";
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = "";
    $("cs-preview").removeAttribute("src");
    existing = null;
    $("cs-match").hidden = true;
    say("");
    showStep("capture");
  }

  function openDialog() {
    opener = document.activeElement;
    resetDialog();
    $("cardscan").hidden = false;
    document.body.classList.add("modal-open");
    $("cs-file").focus();
  }

  function closeDialog() {
    $("cardscan").hidden = true;
    document.body.classList.remove("modal-open");
    if (opener && document.contains(opener) && opener.focus) opener.focus();
  }

  $("cs-fab").addEventListener("click", openDialog);
  $("cs-close").addEventListener("click", closeDialog);
  $("cardscan").addEventListener("mousedown", (e) => {
    if (e.target === $("cardscan") && $("cs-verify").hidden) closeDialog(); // never lose a scanned card to a stray click
  });
  $("cs-retake").addEventListener("click", () => {
    resetDialog();
    $("cs-file").click();
  });
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || !isOpen()) return;
      e.stopPropagation();
      if (!$("cs-verify").hidden && FIELDS.some((f) => val(f)) && !confirm("Discard this scanned card?")) return;
      closeDialog();
    },
    true,
  );

  // --- Photo -> fields ---------------------------------------------------------

  // Phones take 12 MP photos; the card is readable at 1600px, which uploads far faster.
  async function shrink(file) {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024) return file;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.88));
      return blob || file;
    } catch (_) {
      return file; // e.g. a format the browser can't decode; let the server say
    }
  }

  function fill(fields) {
    for (const f of FIELDS) if (f !== "met") form.elements[f].value = fields[f] || "";
  }

  function findExisting(company, email) {
    const name = hub.quicklog.normName(company);
    const lower = (email || "").toLowerCase();
    const linked = new Set(state.accounts.map((a) => a.leadId).filter(Boolean));
    const acct = state.accounts.find((a) => (name && hub.quicklog.normName(a.company) === name) || (lower && (a.email || "").toLowerCase() === lower));
    if (acct) return { kind: "account", id: acct.id, company: acct.company };
    const lead = state.leads.find((l) => !linked.has(l.id) && ((name && hub.quicklog.normName(l.company) === name) || (lower && (l.email || "").toLowerCase() === lower)));
    return lead ? { kind: "lead", id: lead.id, company: lead.company } : null;
  }

  function showMatch() {
    existing = findExisting(val("company"), val("email"));
    $("cs-match").hidden = !existing;
    $("cs-kind").hidden = !!existing;
    if (existing) {
      $("cs-match-label").textContent = `Add this contact to ${existing.company} (${existing.kind})`;
      form.elements["cs-where"].value = "existing";
    }
  }
  for (const r of form.querySelectorAll("input[name=cs-where]")) {
    r.addEventListener("change", () => ($("cs-kind").hidden = form.elements["cs-where"].value === "existing"));
  }
  for (const n of ["company", "email"]) form.elements[n].addEventListener("change", () => !$("cs-verify").hidden && showMatch());

  $("cs-file").addEventListener("change", async () => {
    const file = $("cs-file").files[0];
    if (!file || busy) return;
    busy = true;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(file);
    $("cs-preview").src = previewUrl;
    $("cs-reading").textContent = "Reading the card…";
    $("cs-reading").className = "status";
    showStep("reading");
    try {
      const body = new FormData();
      body.append("file", await shrink(file), "card.jpg");
      const res = await hub.api.fetch("/cards/scan", { method: "POST", body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        const e = new Error(typeof out.detail === "string" ? out.detail : `The server said ${res.status}.`);
        e.status = res.status;
        throw e;
      }
      fill(out.fields || {});
      $("cs-source").textContent =
        out.source === "ai"
          ? "Read by AI from your photo. Compare each field with the card before saving."
          : "Read with basic text recognition, which is less accurate. Check every field against the card.";
      showStep("verify");
      showMatch();
      say("");
      (val("company") ? form.elements.name : form.elements.company).focus();
    } catch (err) {
      if (err.status === 503) {
        // No reader on the server: let the rep type it, with the photo as a reference.
        fill({});
        $("cs-source").textContent = `${err.message} The photo is shown for reference.`;
        showStep("verify");
        showMatch();
      } else {
        resetDialog();
        $("cs-reading").hidden = false;
        $("cs-reading").textContent = err.message;
        $("cs-reading").className = "status err";
      }
    } finally {
      busy = false;
    }
  });

  // --- Saving ------------------------------------------------------------------

  function problems() {
    if (!val("company")) return ["company", "Enter the company name."];
    if (val("email") && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val("email"))) return ["email", "That email doesn't look right."];
    if (val("state") && !/^[A-Za-z]{2}$/.test(val("state"))) return ["state", "Use the 2-letter state, like PA."];
    if (val("zip") && !/^\d{5}(-\d{4})?$/.test(val("zip"))) return ["zip", "ZIP should be 5 digits."];
    return null;
  }

  const extraLine = (c) => [c.name, c.title, c.email, c.phone && `phone ${c.phone}`, c.mobile && `mobile ${c.mobile}`].filter(Boolean).join(", ");

  // Adds the contact to a record that already exists without overwriting what is there.
  function mergeInto(target, c) {
    const rec = (target.kind === "account" ? state.accounts : state.leads).find((r) => r.id === target.id);
    if (!rec) return null;
    const sameContact = !rec.contactName || (c.name && rec.contactName.trim().toLowerCase() === c.name.toLowerCase());
    if (sameContact) {
      for (const [field, v] of [["contactName", c.name], ["contactTitle", c.title], ["email", c.email], ["phone", c.phone]]) {
        if (v && !rec[field]) rec[field] = v;
      }
    } else if (!(c.email && JSON.stringify(rec).toLowerCase().includes(c.email.toLowerCase()))) {
      const field = target.kind === "account" ? "otherContacts" : "notes";
      rec[field] = [rec[field], `${target.kind === "lead" ? "Also met: " : ""}${extraLine(c)}`].filter(Boolean).join("\n");
    }
    for (const f of ["website", "address", "city", "state", "zip"]) if (c[f] && !rec[f]) rec[f] = c[f];
    rec.updated = new Date().toISOString();
    return rec;
  }

  function createRecord(c, kind) {
    const base = {
      company: c.company, website: c.website, address: c.address, city: c.city, state: c.state.toUpperCase(), zip: c.zip,
      contactName: c.name, contactTitle: c.title, email: c.email, phone: c.phone,
    };
    const extras = [c.mobile && `Mobile: ${c.mobile}`].filter(Boolean).join("\n");
    if (kind === "account") return { kind, rec: hub.accounts.add({ ...base, notes: extras }) };
    return { kind, rec: hub.addLead({ ...base, source: "Business card", stage: "new", notes: extras }) };
  }

  function submit(another) {
    const bad = problems();
    if (bad) {
      form.elements[bad[0]].focus();
      return say(bad[1], "err");
    }
    const c = Object.fromEntries(FIELDS.map((f) => [f, val(f)]));
    let target;
    if (existing && form.elements["cs-where"].value === "existing") {
      if (!mergeInto(existing, c)) return say("That record is no longer available. Create a new one instead.", "err");
      target = existing;
    } else {
      const made = createRecord(c, form.elements["cs-kind"].value);
      target = { kind: made.kind, id: made.rec.id };
    }
    if (c.met) hub.quicklog.fileNote(target, { type: "meeting", date: hub.today(), text: c.met, via: "business card" });
    hub.save();
    hub.quicklog.flash(`Saved ${c.name || c.company}.`);
    if (another) {
      resetDialog();
      return;
    }
    closeDialog();
    if (target.kind === "account") hub.accounts.open(target.id);
    else hub.openLead(target.id);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(false);
  });
  $("cs-save-more").addEventListener("click", () => submit(true));

  // --- Wiring ------------------------------------------------------------------

  const setSignedIn = (on) => {
    $("cs-fab").hidden = !on;
    if (!on && isOpen()) closeDialog();
  };
  window.addEventListener("saleshub:signedin", () => setSignedIn(true));
  window.addEventListener("saleshub:signedout", () => setSignedIn(false));
  setSignedIn(!!hub.auth);
})();
