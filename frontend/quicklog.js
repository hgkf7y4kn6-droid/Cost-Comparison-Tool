// Quick note capture ("Log a touch"): log a call, visit or meeting right after
// it happens instead of typing it all up at the end of the day.
//
// - Type it, or dictate it: the microphone button uses the browser's built-in
//   speech recognition (no extra service to set up). On a phone you can also
//   use the keyboard's own microphone key.
// - "Tidy with AI" asks the server (POST /notes/structure) to clean up a
//   rambling note and pull out the kind of touch, the next action and its date.
//   Without an AI key on the server it still fills in those fields using simple
//   rules, and says so.
// - "Connect your tools": a CRM automation, AI meeting recorder or Zapier zap
//   can POST notes to /notes/inbound with the rep's key. They land in an inbox
//   on the Today tab, where the rep confirms which account or lead they belong
//   to (nothing is filed on a guess).
// - Notes are saved as activities on the account (accounts.js) or lead, so they
//   sync like everything else. A half-written note is kept as a draft on this
//   device until it is saved or discarded.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;

  const TYPES = {
    call: "Call",
    visit: "Site visit",
    meeting: "In-person meeting",
    virtual: "Virtual meeting",
    email: "Email",
    issue: "Issue / complaint",
    review: "Business review",
    note: "Note",
  };
  const CONTACT_TYPES = ["call", "visit", "meeting", "virtual", "email", "review"];
  const EARLY_STAGES = ["new", "enriched", "verified"];
  const DRAFT_KEY = "ob.quicklog.draft.v1";
  const INBOX_EVERY_MS = 5 * 60 * 1000;

  const form = $("ql-form");
  const who = $("ql-who");
  const typeSel = $("ql-type");
  const dateIn = $("ql-date");
  const text = $("ql-text");
  const nextIn = $("ql-next");
  const nextDateIn = $("ql-next-date");
  const statusEl = $("ql-status");
  const live = $("ql-live");

  for (const [value, label] of Object.entries(TYPES)) typeSel.add(new Option(label, value));

  let targets = new Map(); // datalist label -> { kind: "account" | "lead", id, company }
  let usedDictation = false;
  let usedAi = false;
  let typeTouched = false;
  let opener = null;

  // --- Who can a note be filed to? ---------------------------------------------

  const normName = (s) =>
    String(s || "").toLowerCase().replace(/&/g, " and ").replace(/\b(inc|llc|l\.l\.c|co|corp|corporation|company|ltd)\b\.?/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim();

  function buildTargets() {
    targets = new Map();
    const linkedLeads = new Set(state.accounts.map((a) => a.leadId).filter(Boolean));
    const add = (kind, rec, suffix) => {
      let label = `${rec.company} — ${suffix}`;
      for (let n = 2; targets.has(label); n++) label = `${rec.company} — ${suffix} (${n})`;
      targets.set(label, { kind, id: rec.id, company: rec.company });
    };
    for (const a of state.accounts) if (a.company && a.status !== "churned") add("account", a, "account");
    for (const l of state.leads) if (l.company && !linkedLeads.has(l.id)) add("lead", l, "lead");
    const list = $("ql-who-list");
    list.replaceChildren(...[...targets.keys()].sort((a, b) => a.localeCompare(b)).slice(0, 3000).map((label) => new Option(label)));
  }

  const labelFor = (kind, id) => [...targets].find(([, t]) => t.kind === kind && t.id === id)?.[0] || "";

  function resolveTarget(inputValue) {
    const v = inputValue.trim();
    if (targets.has(v)) return targets.get(v);
    const lower = v.toLowerCase();
    const hits = [...targets].filter(([label, t]) => label.toLowerCase() === lower || normName(t.company) === normName(v));
    return hits.length === 1 ? hits[0][1] : null; // ambiguous or unknown: make the rep choose
  }

  function defaultTarget() {
    if (!$("lead-detail").hidden && hub.currentLeadId && hub.currentLeadId()) {
      const lead = state.leads.find((l) => l.id === hub.currentLeadId());
      const acct = lead && state.accounts.find((a) => a.leadId === lead.id);
      return acct ? labelFor("account", acct.id) : lead ? labelFor("lead", lead.id) : "";
    }
    if (!$("account-detail").hidden && hub.accounts.current && hub.accounts.current()) return labelFor("account", hub.accounts.current());
    const deal = hub.deal && hub.deal.resolve();
    if (deal) return deal.acct ? labelFor("account", deal.acct.id) : labelFor("lead", deal.lead.id);
    return "";
  }

  // --- Draft (kept on this device until saved) ---------------------------------

  function saveDraft() {
    try {
      const d = { who: who.value, type: typeSel.value, date: dateIn.value, text: text.value, next: nextIn.value, nextDate: nextDateIn.value };
      if (d.text.trim() || d.next.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
      else localStorage.removeItem(DRAFT_KEY);
    } catch (_) {
      // storage unavailable — the draft just isn't kept
    }
  }

  const loadDraft = () => {
    try {
      return JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
    } catch (_) {
      return null;
    }
  };

  const clearDraft = () => {
    try {
      localStorage.removeItem(DRAFT_KEY);
    } catch (_) {
      // storage unavailable
    }
  };

  // --- Dictation ---------------------------------------------------------------

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let listening = false;

  function setListening(on) {
    listening = on;
    $("ql-mic").setAttribute("aria-pressed", String(on));
    if (!on) live.textContent = "";
  }

  function appendDictated(chunk) {
    chunk = chunk.trim();
    if (!chunk) return;
    const cur = text.value.replace(/\s+$/, "");
    // Speech engines return phrases, not sentences: join them as sentences.
    const sep = !cur ? "" : /[.!?:]$/.test(cur) ? " " : ". ";
    if (!cur || sep) chunk = chunk[0].toUpperCase() + chunk.slice(1);
    text.value = cur + sep + chunk;
    text.scrollTop = text.scrollHeight;
    usedDictation = true;
    saveDraft();
  }

  function startDictation() {
    if (!SpeechRecognition) return;
    recognizer = new SpeechRecognition();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = navigator.language || "en-US";
    recognizer.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) appendDictated(r[0].transcript);
        else interim += r[0].transcript;
      }
      live.textContent = interim ? `… ${interim}` : "";
    };
    recognizer.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      setListening(false);
      say(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access is blocked. Allow it in your browser's site settings, or use your keyboard's microphone key."
          : e.error === "network"
            ? "Dictation needs an internet connection. You can keep typing."
            : `Dictation stopped (${e.error}). You can keep typing.`,
        "err",
      );
    };
    // Browsers end a session after a pause; keep going until the rep stops it.
    recognizer.onend = () => {
      if (!listening) return;
      try {
        recognizer.start();
      } catch (_) {
        setListening(false);
      }
    };
    setListening(true);
    try {
      recognizer.start();
    } catch (_) {
      setListening(false);
    }
  }

  function stopDictation() {
    const was = listening;
    setListening(false);
    if (recognizer) {
      try {
        recognizer.stop();
      } catch (_) {
        // already stopped
      }
    }
    return was;
  }

  $("ql-mic").addEventListener("click", () => {
    say("");
    if (listening) stopDictation();
    else startDictation();
    text.focus();
  });

  if (!SpeechRecognition) {
    $("ql-mic").hidden = true;
    $("ql-hint").textContent = "Voice typing: tap the microphone key on your phone's keyboard, or use your computer's dictation shortcut.";
  } else {
    $("ql-hint").textContent = "Dictation uses your browser's speech service, so audio may leave this device. Don't dictate anything you wouldn't send to it.";
  }

  // --- Status line -------------------------------------------------------------

  function say(message, tone = "", undo) {
    statusEl.textContent = message;
    statusEl.className = `status ${tone}`;
    if (undo) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "link-btn";
      b.textContent = "Undo";
      b.addEventListener("click", () => {
        undo();
        say("");
      });
      statusEl.append(" ", b);
    }
  }

  // --- Tidy with AI ------------------------------------------------------------

  $("ql-ai").addEventListener("click", async () => {
    const raw = text.value.trim();
    if (!raw) return say("Write or dictate something first.", "err");
    stopDictation();
    const btn = $("ql-ai");
    btn.disabled = true;
    say("Tidying…");
    try {
      const res = await hub.api.fetch("/notes/structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: raw, context: who.value.split(" — ")[0] }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof out.detail === "string" ? out.detail : `The server said ${res.status}.`);
      const before = { text: text.value, type: typeSel.value, next: nextIn.value, nextDate: nextDateIn.value };
      if (out.source === "ai") {
        text.value = out.notes || before.text;
        usedAi = true;
      }
      if (!typeTouched && TYPES[out.type]) typeSel.value = out.type;
      if (out.nextAction && !nextIn.value.trim()) nextIn.value = out.nextAction;
      if (out.nextActionDate && !nextDateIn.value) nextDateIn.value = out.nextActionDate;
      saveDraft();
      say(
        out.source === "ai"
          ? "Tidied. Check it over before saving."
          : "Filled in the kind of touch and next action. (AI rewriting is off — ask your administrator to set ANTHROPIC_API_KEY on the server.)",
        "ok",
        () => {
          text.value = before.text;
          typeSel.value = before.type;
          nextIn.value = before.next;
          nextDateIn.value = before.nextDate;
          usedAi = false;
          saveDraft();
        },
      );
    } catch (err) {
      say(`Couldn't tidy this: ${err.message} Your note is unchanged.`, "err");
    } finally {
      btn.disabled = false;
    }
  });

  // --- Filing a note -----------------------------------------------------------

  const describe = (n) => {
    const bits = [];
    if (n.via) bits.push(n.via);
    return bits.join(" · ");
  };

  // Adds the note to the account or lead. Returns an error message, or "" on success. Does not save.
  function fileNote(target, n) {
    const type = TYPES[n.type] ? n.type : "note";
    const via = describe(n);
    const extra = { via, inboxId: n.inboxId };
    if (target.kind === "account") {
      const acct = state.accounts.find((a) => a.id === target.id);
      if (!acct) return "That account is no longer available.";
      hub.accounts.log(acct.id, type, n.text, n.date, 0, extra);
      if (n.next) {
        acct.nextAction = n.next;
        acct.nextActionDate = n.nextDate || "";
      }
      return "";
    }
    const lead = state.leads.find((l) => l.id === target.id);
    if (!lead) return "That lead is no longer available.";
    lead.activities = lead.activities || [];
    const entry = { id: hub.newId("act"), date: n.date || hub.today(), type, text: n.text };
    if (via) entry.via = via.slice(0, 60);
    if (n.inboxId) entry.inboxId = n.inboxId;
    lead.activities.push(entry);
    if (n.next) {
      lead.nextAction = n.next;
      lead.nextActionDate = n.nextDate || "";
    }
    if (EARLY_STAGES.includes(lead.stage) && CONTACT_TYPES.includes(type)) lead.stage = "contacted";
    lead.updated = new Date().toISOString();
    return "";
  }

  function readForm() {
    return {
      type: typeSel.value,
      date: dateIn.value || hub.today(),
      text: text.value.trim(),
      next: nextIn.value.trim() || (nextDateIn.value ? "Follow up" : ""),
      nextDate: nextDateIn.value,
      via: [usedDictation && "dictated", usedAi && "AI-tidied"].filter(Boolean).join(" · "),
    };
  }

  function resetForm(keepWho) {
    stopDictation();
    if (!keepWho) who.value = "";
    text.value = "";
    nextIn.value = "";
    nextDateIn.value = "";
    typeSel.value = "call";
    dateIn.value = hub.today();
    usedDictation = usedAi = typeTouched = false;
    clearDraft();
  }

  function submit(another) {
    stopDictation();
    const target = resolveTarget(who.value);
    if (!target) {
      who.focus();
      return say(who.value.trim() ? "Pick the company from the list so the note goes to the right place." : "Who was this with? Pick a company.", "err");
    }
    const n = readForm();
    if (!n.text) {
      text.focus();
      return say("Add some notes first.", "err");
    }
    const problem = fileNote(target, n);
    if (problem) return say(problem, "err");
    hub.save();
    const company = target.company;
    resetForm(false);
    if (another) {
      say(`Saved to ${company}. Log the next one.`, "ok");
      who.focus();
    } else {
      closeDialog();
      flash(`Saved to ${company}.`);
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit(false);
  });
  $("ql-save-more").addEventListener("click", () => submit(true));

  $("ql-discard").addEventListener("click", () => {
    if ((text.value.trim() || nextIn.value.trim()) && !confirm("Discard this note?")) return;
    resetForm(false);
    say("");
  });

  $("ql-copy").addEventListener("click", async () => {
    const n = readForm();
    if (!n.text) return say("Add some notes first.", "err");
    const company = (resolveTarget(who.value) || {}).company || who.value.split(" — ")[0].trim();
    const lines = [`${TYPES[n.type]} — ${company || "(no company)"} — ${hub.fmtDate(n.date)}`, n.text];
    if (n.next) lines.push(`Next: ${n.next}${n.nextDate ? ` (due ${hub.fmtDate(n.nextDate)})` : ""}`);
    const out = lines.join("\n");
    try {
      await navigator.clipboard.writeText(out);
      say("Copied. Paste it into your CRM.", "ok");
    } catch (_) {
      text.focus();
      say("Couldn't reach the clipboard. Select the notes and copy them by hand.", "err");
    }
  });

  // A short confirmation that survives the dialog closing.
  function flash(message) {
    const el = document.createElement("div");
    el.className = "ql-toast";
    el.setAttribute("role", "status");
    el.textContent = message;
    Object.assign(el.style, {
      position: "fixed", left: "50%", bottom: "5.5em", transform: "translateX(-50%)", zIndex: 90,
      background: "var(--ink)", color: "var(--on-ink)", padding: "0.6em 1em", borderRadius: "999px", boxShadow: "var(--shadow-3)",
    });
    document.body.append(el);
    setTimeout(() => el.remove(), 3500);
  }

  // --- Dialog ------------------------------------------------------------------

  const isOpen = () => !$("quicklog").hidden;

  function openDialog(prefillWho) {
    buildTargets();
    opener = document.activeElement;
    const draft = loadDraft();
    if (draft && (draft.text || draft.next)) {
      who.value = prefillWho || draft.who || defaultTarget();
      typeSel.value = TYPES[draft.type] ? draft.type : "call";
      dateIn.value = draft.date || hub.today();
      text.value = draft.text || "";
      nextIn.value = draft.next || "";
      nextDateIn.value = draft.nextDate || "";
      say("Picked up your unsaved draft.");
    } else {
      who.value = prefillWho || defaultTarget();
      typeSel.value = "call";
      dateIn.value = hub.today();
      say("");
    }
    typeTouched = false;
    $("quicklog").hidden = false;
    document.body.classList.add("modal-open");
    (who.value ? text : who).focus();
  }

  function closeDialog() {
    stopDictation();
    saveDraft();
    $("quicklog").hidden = true;
    document.body.classList.remove("modal-open");
    if (opener && document.contains(opener) && opener.focus) opener.focus();
  }

  typeSel.addEventListener("change", () => (typeTouched = true));
  for (const el of [who, typeSel, dateIn, text, nextIn, nextDateIn]) el.addEventListener("input", saveDraft);
  $("ql-fab").addEventListener("click", () => openDialog());
  $("ql-close").addEventListener("click", closeDialog);
  $("quicklog").addEventListener("mousedown", (e) => {
    if (e.target === $("quicklog")) closeDialog();
  });
  // Capture phase so Escape closes only this dialog, not the panel behind it.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && isOpen()) {
        e.stopPropagation();
        closeDialog();
      }
    },
    true,
  );

  // --- Connect your tools ------------------------------------------------------

  let integrationLoaded = false;
  const endpoint = () => `${(hub.api && hub.api.base) || location.origin}/notes/inbound`;

  $("ql-connect").addEventListener("toggle", async (e) => {
    if (!e.target.open || integrationLoaded) return;
    $("ql-endpoint").value = endpoint();
    $("ql-sample").textContent =
      `curl -X POST ${endpoint()} \\\n  -H "Authorization: Bearer YOUR_KEY" -H "Content-Type: application/json" \\\n` +
      `  -d '{"company":"Acme Co","type":"call","date":"${hub.today()}","notes":"Talked pricing…","source":"Otter"}'`;
    try {
      const res = await hub.api.fetch("/notes/integration");
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const info = await res.json();
      $("ql-key").value = info.key;
      $("ql-ai-status").textContent = info.ai
        ? "AI tidy-up is on."
        : "AI tidy-up is off: the server has no ANTHROPIC_API_KEY, so “Tidy with AI” only fills in the kind of touch and next action.";
      integrationLoaded = true;
    } catch (err) {
      $("ql-ai-status").textContent = `Couldn't load your key (${err.message}). Try again when you're online.`;
    }
  });
  $("ql-key-show").addEventListener("click", () => {
    const hidden = $("ql-key").type === "password";
    $("ql-key").type = hidden ? "text" : "password";
    $("ql-key-show").textContent = hidden ? "Hide" : "Show";
  });
  $("ql-key-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("ql-key").value);
      $("ql-key-copy").textContent = "Copied";
      setTimeout(() => ($("ql-key-copy").textContent = "Copy"), 1500);
    } catch (_) {
      $("ql-key").type = "text";
      $("ql-key").select();
    }
  });

  // --- Inbox (notes sent by outside tools) -------------------------------------

  let inbox = [];

  const filedInboxIds = () => {
    const ids = new Set();
    for (const rec of [...state.accounts, ...state.leads]) for (const a of rec.activities || []) if (a.inboxId) ids.add(a.inboxId);
    return ids;
  };

  function matchInbound(n) {
    if (n.recordId) {
      if (state.accounts.some((a) => a.id === n.recordId)) return { kind: "account", id: n.recordId };
      if (state.leads.some((l) => l.id === n.recordId)) {
        const acct = state.accounts.find((a) => a.leadId === n.recordId);
        return acct ? { kind: "account", id: acct.id } : { kind: "lead", id: n.recordId };
      }
    }
    if (n.contactEmail) {
      const lead = state.leads.find((l) => (l.email || "").toLowerCase() === n.contactEmail);
      if (lead) {
        const acct = state.accounts.find((a) => a.leadId === lead.id);
        return acct ? { kind: "account", id: acct.id } : { kind: "lead", id: lead.id };
      }
    }
    const name = normName(n.company);
    if (name) {
      const acct = state.accounts.find((a) => normName(a.company) === name);
      if (acct) return { kind: "account", id: acct.id };
      const lead = state.leads.find((l) => normName(l.company) === name);
      if (lead) return { kind: "lead", id: lead.id };
    }
    return null;
  }

  const removing = new Map(); // id -> in-flight delete, so filing + the re-render don't both send one

  function removeFromInbox(id) {
    if (removing.has(id)) return removing.get(id);
    const p = (async () => {
      try {
        const res = await hub.api.fetch(`/notes/inbox/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (res.ok || res.status === 404) inbox = inbox.filter((n) => n.id !== id);
      } catch (_) {
        // offline — it is hidden by filedInboxIds() and removed on the next refresh
      } finally {
        removing.delete(id);
      }
    })();
    removing.set(id, p);
    return p;
  }

  let shownKey = "";

  function renderInbox() {
    const host = $("today-inbox");
    const filed = filedInboxIds();
    for (const n of inbox.filter((x) => filed.has(x.id))) removeFromInbox(n.id); // filed, but the delete didn't go through
    const items = inbox.filter((n) => !filed.has(n.id));
    // Leave the list alone while it is unchanged, so a background sync doesn't wipe what the rep is typing.
    const key = items.map((n) => n.id).join(",");
    if (key === shownKey && host.childElementCount) return;
    shownKey = key;
    host.replaceChildren();
    if (!items.length) return;
    buildTargets();

    const outer = document.createElement("section");
    outer.className = "xcard today-card";
    outer.dataset.card = "today-note-inbox";
    outer.dataset.open = "true";
    const head = document.createElement("div");
    head.className = "xcard-head";
    const titles = document.createElement("div");
    titles.className = "xcard-titles";
    const h = document.createElement("h3");
    h.textContent = "Notes to file";
    const sub = document.createElement("p");
    sub.className = "xcard-sub";
    sub.textContent = "Sent from your connected tools. Confirm where each one belongs.";
    titles.append(h, sub);
    const count = document.createElement("span");
    count.className = "xcard-aside count has";
    count.textContent = items.length;
    head.append(titles, count);
    const body = document.createElement("div");
    body.className = "xcard-body";
    outer.append(head, body);

    for (const n of items) {
      const row = document.createElement("div");
      row.className = "ql-inbox-item";
      const meta = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = n.company || "No company given";
      const small = document.createElement("span");
      small.className = "muted";
      small.textContent = ` · ${n.source} · ${TYPES[n.type] || "Note"} · ${hub.fmtDate(n.date)}`;
      meta.append(strong, small);
      const body2 = document.createElement("p");
      body2.className = "ql-text";
      body2.textContent = n.notes; // untrusted text from another system: textContent only
      const controls = document.createElement("div");
      controls.className = "row-buttons";
      const pick = document.createElement("input");
      pick.type = "text";
      pick.setAttribute("list", "ql-who-list");
      pick.placeholder = "File to… (pick a company)";
      pick.setAttribute("aria-label", `Where to file the note from ${n.source}`);
      const m = matchInbound(n);
      if (m) pick.value = labelFor(m.kind, m.id);
      const fileBtn = document.createElement("button");
      fileBtn.type = "button";
      fileBtn.className = "btn small primary";
      fileBtn.textContent = "File note";
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "btn small";
      dismiss.textContent = "Dismiss";
      const err = document.createElement("span");
      err.className = "status err";
      controls.append(pick, fileBtn, dismiss, err);
      row.append(meta, body2, controls);
      body.append(row);

      fileBtn.addEventListener("click", async () => {
        const target = resolveTarget(pick.value);
        if (!target) {
          err.textContent = "Pick the company from the list.";
          return pick.focus();
        }
        const problem = fileNote(target, { type: n.type || "note", date: n.date, text: n.notes, via: n.source, inboxId: n.id });
        if (problem) {
          err.textContent = problem;
          return;
        }
        hub.save();
        await removeFromInbox(n.id);
        renderInbox();
      });
      dismiss.addEventListener("click", async () => {
        if (!confirm("Dismiss this note without filing it?")) return;
        await removeFromInbox(n.id);
        renderInbox();
      });
    }
    host.append(outer);
    if (hub.cards) hub.cards.init(host);
  }

  async function refreshInbox() {
    if (!hub.auth) return;
    try {
      const res = await hub.api.fetch("/notes/inbox");
      if (!res.ok) return;
      inbox = (await res.json()).notes || [];
      renderInbox();
    } catch (_) {
      // offline — try again later
    }
  }

  // --- Lead notes list ---------------------------------------------------------

  function renderLeadNotes() {
    const id = hub.currentLeadId && hub.currentLeadId();
    const lead = id && state.leads.find((l) => l.id === id);
    const list = $("d-activity");
    list.replaceChildren();
    if (!lead) return;
    const acts = [...(lead.activities || [])].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    for (const a of acts) {
      const li = document.createElement("li");
      const when = document.createElement("span");
      when.className = "muted";
      when.textContent = `${hub.fmtDate(a.date)} · ${TYPES[a.type] || a.type}${a.via ? ` · ${a.via}` : ""}`;
      const del = document.createElement("button");
      del.type = "button";
      del.className = "link-btn danger-text";
      del.textContent = "remove";
      del.addEventListener("click", () => {
        lead.activities = lead.activities.filter((x) => x.id !== a.id);
        lead.updated = new Date().toISOString();
        hub.save();
      });
      when.append(" ", del);
      const body = document.createElement("div");
      body.textContent = a.text;
      body.style.whiteSpace = "pre-wrap";
      li.append(when, body);
      list.append(li);
    }
    $("d-no-activity").hidden = acts.length > 0;
    $("d-activity-aside").textContent = acts.length ? `${acts.length} logged` : "";
    const next = $("d-next-action");
    next.hidden = !lead.nextAction;
    next.textContent = lead.nextAction ? `Next: ${lead.nextAction}${lead.nextActionDate ? ` — due ${hub.fmtDate(lead.nextActionDate)}` : ""}` : "";
  }

  $("d-log-touch").addEventListener("click", () => openDialog());
  new MutationObserver(renderLeadNotes).observe($("lead-detail"), { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(renderLeadNotes).observe($("d-title"), { childList: true, characterData: true, subtree: true });

  // --- Wiring ------------------------------------------------------------------

  const setSignedIn = (on) => {
    $("ql-fab").hidden = !on;
    if (!on && isOpen()) closeDialog();
  };
  window.addEventListener("saleshub:signedin", () => {
    setSignedIn(true);
    integrationLoaded = false;
    refreshInbox();
  });
  window.addEventListener("saleshub:signedout", () => {
    setSignedIn(false);
    inbox = [];
    shownKey = "";
    $("today-inbox").replaceChildren();
  });
  hub.on(() => {
    renderLeadNotes();
    if (inbox.length) renderInbox();
  });
  setInterval(refreshInbox, INBOX_EVERY_MS);
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refreshInbox());

  hub.quicklog = { open: openDialog, refreshInbox, fileNote, normName, flash };
  setSignedIn(!!hub.auth);
  renderLeadNotes();
  if (hub.auth) refreshInbox();
})();
