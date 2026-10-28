// Keeps accounts and leads in step with the server (accounts_store.py), which
// decides who sees what:
// - state.accounts: accounts this user may open in full — their own, every
//   prospective account (no orders this year), or every account for a manager;
// - SalesHub.sharedAccounts: the name/address/phone/YTD view of other reps'
//   customer accounts, for the map;
// - state.leads: the team's shared lead list.
//
// Edits are saved locally first (so the app keeps working offline) and pushed
// shortly after; records that only exist in this browser (created before the
// server held them, or while offline) are uploaded on the next pull.
//
// Every record has a revision (`rev`) assigned by the server. A push says which
// revision it was based on; if someone else saved in between, the server refuses
// it (a "conflict"), the latest server version is loaded, and the edit that lost
// is kept in this browser (see Backup → "Edits replaced by newer changes") instead
// of silently overwriting the other person's work.
(function () {
  const hub = window.SalesHub;
  const state = hub.state;
  const KEY = "ob.records.synced.v1";
  const PULL_EVERY_MS = 5 * 60 * 1000;
  const BULK_CHUNK = 500;
  const KINDS = ["accounts", "leads", "quotes"];
  // Proposals carry supplier costs and margins, so they only go to the server once the
  // person turns that on (enableQuotes); the server then lists them to their owner alone.
  const activeKinds = () => KINDS.filter((k) => k !== "quotes" || (state.settings || {}).syncQuotes === true);

  // kind -> id -> the record as last agreed with the server (server-computed fields left out)
  let synced = { accounts: {}, leads: {} };
  let syncedFor = "";
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved && saved.synced) ({ synced, syncedFor = "" } = saved);
    // Earlier builds synced accounts only, under another key.
    const old = JSON.parse(localStorage.getItem("ob.accounts.synced.v1") || "null");
    if (old && old.synced && !saved) {
      synced.accounts = old.synced;
      syncedFor = old.syncedFor || "";
      localStorage.removeItem("ob.accounts.synced.v1");
    }
  } catch (_) {
    synced = { accounts: {}, leads: {} };
  }
  for (const k of KINDS) synced[k] = synced[k] || {};
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ synced, syncedFor }));
    } catch (_) {
      // storage unavailable
    }
  };

  hub.sharedAccounts = [];
  let pulled = false;
  let serverReset = false;
  let pushing = false;
  let again = false;
  let timer = null;

  const SERVER_FIELDS = ["ownerEmail", "ytdSpend", "limited", "score", "rev"];
  const CONFLICTS_KEY = "ob.records.conflicts.v1";
  const MAX_CONFLICTS = 50;

  function readConflicts() {
    try {
      const list = JSON.parse(localStorage.getItem(CONFLICTS_KEY) || "[]");
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }
  // Keeps the version of a record that lost to someone else's save.
  function stashConflict(kind, rec) {
    const list = readConflicts();
    list.push({ at: new Date().toISOString(), kind, id: rec.id, company: rec.company || "", record: rec });
    try {
      localStorage.setItem(CONFLICTS_KEY, JSON.stringify(list.slice(-MAX_CONFLICTS)));
    } catch (_) {
      // storage full: the in-memory copy is all there is
    }
  }
  const comparable = (r) => {
    const copy = { ...r };
    for (const f of SERVER_FIELDS) delete copy[f];
    return JSON.stringify(copy);
  };
  const time = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  function setStatus(text, tone = "") {
    for (const el of document.querySelectorAll("[data-sync-status]")) {
      el.textContent = text;
      el.className = `sync-status ${tone}`;
    }
  }
  const offline = (why) => setStatus(`Offline — changes are saved on this device and will sync when the server is reachable (${why}).`, "warn");

  function merge(kind, serverRecords) {
    const known = synced[kind];
    // The server answered with nothing although this browser had records it had synced before.
    // That looks like the server lost its data (e.g. a restart without the persistent disk), not
    // like everyone deleting everything: keep the local copies and upload them again.
    if (serverRecords.length === 0 && Object.keys(known).length > 0) {
      for (const id of Object.keys(known)) delete known[id];
      serverReset = true;
    }
    const remote = new Map(serverRecords.map((r) => [r.id, r]));
    const next = [];
    for (const local of state[kind]) {
      const theirs = remote.get(local.id);
      if (theirs) {
        remote.delete(local.id);
        const editedHere = local.id in known && comparable(local) !== known[local.id];
        // Keep our own `rev` when we've edited: it names the version the edit was based on.
        if (editedHere) next.push({ ...local, ownerEmail: theirs.ownerEmail, ytdSpend: theirs.ytdSpend });
        else {
          // Never agreed with the server (e.g. made offline) yet the server has this id with different content:
          // the server's copy wins, but ours is kept rather than dropped.
          if (!(local.id in known) && comparable(local) !== comparable(theirs)) stashConflict(kind, local);
          next.push(theirs);
          known[theirs.id] = comparable(theirs);
        }
      } else if (!(local.id in known)) {
        next.push(local); // never uploaded — pushed next
      } else {
        delete known[local.id]; // deleted on the server, or now someone else's customer account
      }
    }
    for (const theirs of remote.values()) {
      next.push(theirs);
      known[theirs.id] = comparable(theirs);
    }
    state[kind] = next;
  }

  async function pull() {
    if (!hub.auth) return;
    // A different person signed in on this browser: drop what the previous
    // user had from the server and fetch this user's view.
    if (syncedFor && syncedFor !== hub.auth.email) {
      for (const k of KINDS) {
        state[k] = state[k].filter((r) => !(r.id in synced[k]));
        synced[k] = {};
      }
    }
    syncedFor = hub.auth.email;
    setStatus("Syncing…");
    let results;
    try {
      results = await Promise.all(activeKinds().map(async (k) => {
        const res = await hub.api.fetch(`/records/${k}/`);
        if (!res.ok) throw new Error(`server said ${res.status}`);
        return res.json();
      }));
    } catch (err) {
      offline(err.message);
      return;
    }
    const kinds = activeKinds();
    kinds.forEach((k, i) => merge(k, results[i].records || []));
    hub.sharedAccounts = results[kinds.indexOf("accounts")].others || [];
    if (hub.auth && results[0].role) hub.auth.role = results[0].role;
    if (kinds.includes("quotes")) keepQuoteNumbersUnique();
    pulled = true;
    persist();
    hub.save(); // re-renders, and schedules a push for anything edited or new here
    if (serverReset) {
      serverReset = false;
      setStatus("The server had none of your records, so they were kept here and are being uploaded again. If this keeps happening, tell your administrator (the server's data disk may not be attached).", "warn");
    } else setStatus(`Synced ${time()}`, "ok");
  }

  // Quote numbers (Q-2026-007) come from a per-browser counter; once proposals follow
  // a person across devices, the counter has to move past any number already used.
  function keepQuoteNumbersUnique() {
    for (const q of state.quotes) {
      const m = /^Q-(\d{4})-(\d+)$/.exec(q.number || "");
      if (!m) continue;
      const key = `quote-${m[1]}`;
      state.counters[key] = Math.max(state.counters[key] || 0, Number(m[2]));
    }
  }

  function enableQuotes() {
    state.settings = state.settings || {};
    state.settings.syncQuotes = true;
    hub.save();
    return pull();
  }

  function bodyFor(rec, json) {
    const body = JSON.parse(json);
    if (Number.isInteger(rec.rev)) body.baseRev = rec.rev; // the server refuses the save if the record moved on
    // Owner changes travel with the record; the server decides if they're allowed.
    if (rec.ownerEmail) body.ownerEmail = rec.ownerEmail;
    return body;
  }

  async function pushKind(kind) {
    const known = synced[kind];
    const changed = state[kind].map((r) => [r, comparable(r)]).filter(([r, json]) => known[r.id] !== json);
    let note = "";
    let updatedFromServer = false;
    let conflicted = false;
    for (let i = 0; i < changed.length; i += BULK_CHUNK) {
      const chunk = changed.slice(i, i + BULK_CHUNK);
      const res = await hub.api.fetch(`/records/${kind}/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ records: chunk.map(([r, json]) => bodyFor(r, json)) }),
      });
      if (!res.ok) throw new Error(`server said ${res.status}`);
      const out = await res.json();
      const byId = new Map(chunk.map(([r, json]) => [r.id, [r, json]]));
      for (const saved of out.saved) {
        const [rec, json] = byId.get(saved.id) || [];
        if (!rec) continue;
        if (rec.ownerEmail !== saved.ownerEmail || (kind === "accounts" && rec.ytdSpend !== saved.ytdSpend)) updatedFromServer = true;
        rec.ownerEmail = saved.ownerEmail;
        rec.rev = saved.rev;
        if (kind === "accounts") rec.ytdSpend = saved.ytdSpend;
        known[rec.id] = json;
      }
      for (const err of out.errors) {
        const [rec, json] = byId.get(err.id) || [];
        if (rec) known[rec.id] = json; // don't retry a refused record forever
        if (err.conflict && rec) {
          // Someone else saved first. Keep our version aside; the next pull loads theirs.
          stashConflict(kind, JSON.parse(JSON.stringify(rec)));
          conflicted = true;
          note = `${rec.company || "A record"} was changed by someone else while you were editing it. Their version is now showing; your edit was kept (Backup → Edits replaced by newer changes).`;
          continue;
        }
        note = err.forbidden
          ? `${rec ? rec.company : "A record"} is another rep's customer account; your changes to it weren't saved.`
          : `Couldn't save ${rec ? rec.company : "a record"}: ${err.error}`;
      }
    }
    const ids = new Set(state[kind].map((r) => r.id));
    for (const id of Object.keys(known)) {
      if (ids.has(id)) continue;
      const res = await hub.api.fetch(`/records/${kind}/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (res.ok || res.status === 404) delete known[id];
      else if (res.status === 403) {
        delete known[id];
        note = "Only a record's owner or a manager can delete it; it will come back on the next sync.";
      } else throw new Error(`server said ${res.status}`);
    }
    return { note, updatedFromServer, conflicted };
  }

  async function push() {
    if (!pulled || !hub.auth) return;
    if (pushing) {
      again = true;
      return;
    }
    pushing = true;
    let note = "";
    let refresh = false;
    let conflicted = false;
    try {
      for (const k of activeKinds()) {
        const r = await pushKind(k);
        note = r.note || note;
        refresh = refresh || r.updatedFromServer;
        conflicted = conflicted || r.conflicted;
      }
      setStatus(note || `Synced ${time()}`, note ? "warn" : "ok");
    } catch (err) {
      offline(err.message);
    } finally {
      pushing = false;
      persist();
    }
    if (refresh) hub.save();
    if (conflicted) {
      await pull(); // load the version that won
      setStatus(note, "warn");
    }
    if (again) {
      again = false;
      push();
    }
  }

  // Pushes shortly after edits stop, but never later than MAX_WAIT_MS after the first unsent edit,
  // so a stream of edits can't leave work sitting only in this browser.
  const MAX_WAIT_MS = 5000;
  let pendingSince = 0;
  hub.on(() => {
    if (!pendingSince) pendingSince = Date.now();
    clearTimeout(timer);
    const wait = Math.max(0, Math.min(800, pendingSince + MAX_WAIT_MS - Date.now()));
    timer = setTimeout(() => {
      pendingSince = 0;
      push();
    }, wait);
  });

  window.addEventListener("saleshub:signedin", () => pull());
  window.addEventListener("saleshub:signedout", () => {
    hub.sharedAccounts = [];
    pulled = false;
    setStatus("");
  });
  // Pick up teammates' changes regularly, and when coming back to the tab.
  setInterval(() => hub.auth && pull(), PULL_EVERY_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && hub.auth && pulled) pull();
  });

  // The Proposals tab says plainly where proposals live, and offers to back them up.
  function renderQuoteNote() {
    const box = document.getElementById("q-sync-note");
    if (!box) return;
    box.replaceChildren();
    if (!hub.auth) return;
    if ((state.settings || {}).syncQuotes === true) {
      box.append("Proposals are saved to the server and follow you to other devices. Only you can see them there; they include your supplier costs and margins.");
      return;
    }
    box.append("Proposals are stored only in this browser — not backed up and not on your other devices. ");
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn";
    b.textContent = "Save my proposals to the server";
    b.addEventListener("click", () => {
      if (confirm("Upload your proposals, including supplier costs and margins, to the server? They will be visible only to you, backed up with the rest of the server's data, and available when you sign in on another device.")) enableQuotes();
    });
    box.append(b);
  }
  hub.on(renderQuoteNote);
  window.addEventListener("saleshub:signedin", renderQuoteNote);
  window.addEventListener("saleshub:signedout", renderQuoteNote);
  renderQuoteNote();

  hub.sync = { pull, push, enableQuotes, conflicts: readConflicts, clearConflicts: () => localStorage.removeItem(CONFLICTS_KEY) };
  if (hub.auth) pull();
})();
