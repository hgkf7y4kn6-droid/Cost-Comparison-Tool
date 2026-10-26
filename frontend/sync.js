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
(function () {
  const hub = window.SalesHub;
  const state = hub.state;
  const KEY = "ob.records.synced.v1";
  const PULL_EVERY_MS = 5 * 60 * 1000;
  const BULK_CHUNK = 500;
  const KINDS = ["accounts", "leads"];

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
  let pushing = false;
  let again = false;
  let timer = null;

  const SERVER_FIELDS = ["ownerEmail", "ytdSpend", "limited", "score"];
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
    const remote = new Map(serverRecords.map((r) => [r.id, r]));
    const next = [];
    for (const local of state[kind]) {
      const theirs = remote.get(local.id);
      if (theirs) {
        remote.delete(local.id);
        const editedHere = local.id in known && comparable(local) !== known[local.id];
        if (editedHere) next.push({ ...local, ownerEmail: theirs.ownerEmail, ytdSpend: theirs.ytdSpend });
        else {
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
      results = await Promise.all(KINDS.map(async (k) => {
        const res = await hub.api.fetch(`/records/${k}/`);
        if (!res.ok) throw new Error(`server said ${res.status}`);
        return res.json();
      }));
    } catch (err) {
      offline(err.message);
      return;
    }
    KINDS.forEach((k, i) => merge(k, results[i].records || []));
    hub.sharedAccounts = results[0].others || [];
    if (hub.auth && results[0].role) hub.auth.role = results[0].role;
    pulled = true;
    persist();
    hub.save(); // re-renders, and schedules a push for anything edited or new here
    setStatus(`Synced ${time()}`, "ok");
  }

  function bodyFor(rec, json) {
    const body = JSON.parse(json);
    // Owner changes travel with the record; the server decides if they're allowed.
    if (rec.ownerEmail) body.ownerEmail = rec.ownerEmail;
    return body;
  }

  async function pushKind(kind) {
    const known = synced[kind];
    const changed = state[kind].map((r) => [r, comparable(r)]).filter(([r, json]) => known[r.id] !== json);
    let note = "";
    let updatedFromServer = false;
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
        if (kind === "accounts") rec.ytdSpend = saved.ytdSpend;
        known[rec.id] = json;
      }
      for (const err of out.errors) {
        const [rec, json] = byId.get(err.id) || [];
        if (rec) known[rec.id] = json; // don't retry a refused record forever
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
    return { note, updatedFromServer };
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
    try {
      for (const k of KINDS) {
        const r = await pushKind(k);
        note = r.note || note;
        refresh = refresh || r.updatedFromServer;
      }
      setStatus(note || `Synced ${time()}`, note ? "warn" : "ok");
    } catch (err) {
      offline(err.message);
    } finally {
      pushing = false;
      persist();
    }
    if (refresh) hub.save();
    if (again) {
      again = false;
      push();
    }
  }

  hub.on(() => {
    clearTimeout(timer);
    timer = setTimeout(push, 800);
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

  hub.sync = { pull, push };
  if (hub.auth) pull();
})();
