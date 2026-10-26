// Keeps accounts in step with the server (accounts_store.py), which decides
// who sees what. state.accounts holds the accounts this user may open in full
// (their own; every account for a manager); SalesHub.sharedAccounts holds the
// name/address/phone/YTD-spend view of everyone else's, for the map.
//
// Edits are saved locally first (so the app keeps working offline) and pushed
// shortly after; accounts that only exist in this browser (created before
// accounts moved to the server, or while offline) are uploaded on the next pull.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const KEY = "ob.accounts.synced.v1";
  const PULL_EVERY_MS = 5 * 60 * 1000;

  // id -> the record as last agreed with the server (server-computed fields left out)
  let synced = {};
  let syncedFor = "";
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    if (saved) ({ synced = {}, syncedFor = "" } = saved);
  } catch (_) {
    synced = {};
  }
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

  const comparable = (a) => {
    const { ownerEmail, ytdSpend, limited, ...rest } = a;
    return JSON.stringify(rest);
  };

  function setStatus(text, tone = "") {
    for (const el of document.querySelectorAll("[data-sync-status]")) {
      el.textContent = text;
      el.className = `sync-status ${tone}`;
    }
  }

  async function pull() {
    if (!hub.auth) return;
    // A different person signed in on this browser: the previous user's
    // server accounts aren't theirs to see.
    if (syncedFor && syncedFor !== hub.auth.email) {
      state.accounts = state.accounts.filter((a) => !(a.id in synced));
      synced = {};
    }
    syncedFor = hub.auth.email;
    setStatus("Syncing accounts…");
    let data;
    try {
      const res = await hub.api.fetch("/accounts/");
      if (!res.ok) throw new Error(`server said ${res.status}`);
      data = await res.json();
    } catch (err) {
      setStatus(`Offline — account changes are saved here and will sync when the server is reachable (${err.message}).`, "warn");
      return;
    }
    if (hub.auth && data.role) hub.auth.role = data.role;
    const remote = new Map(data.accounts.map((a) => [a.id, a]));
    const next = [];
    for (const local of state.accounts) {
      const theirs = remote.get(local.id);
      if (theirs) {
        remote.delete(local.id);
        const editedHere = local.id in synced && comparable(local) !== synced[local.id];
        if (editedHere) next.push({ ...local, ownerEmail: theirs.ownerEmail, ytdSpend: theirs.ytdSpend });
        else {
          next.push(theirs);
          synced[theirs.id] = comparable(theirs);
        }
      } else if (!(local.id in synced)) {
        next.push(local); // never uploaded — pushed below
      } else {
        delete synced[local.id]; // deleted on the server, or reassigned to someone else
      }
    }
    for (const theirs of remote.values()) {
      next.push(theirs);
      synced[theirs.id] = comparable(theirs);
    }
    state.accounts = next;
    hub.sharedAccounts = data.others || [];
    pulled = true;
    persist();
    hub.save(); // re-renders, and schedules a push for anything edited or new here
    setStatus(`Accounts synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "ok");
  }

  async function push() {
    if (!pulled || !hub.auth) return;
    if (pushing) {
      again = true;
      return;
    }
    pushing = true;
    let changedFromServer = false;
    let failed = "";
    try {
      for (const acct of [...state.accounts]) {
        const body = comparable(acct);
        if (synced[acct.id] === body) continue;
        const res = await hub.api.fetch(`/accounts/${encodeURIComponent(acct.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...JSON.parse(body), ...(hub.auth.role === "manager" && acct.ownerEmail ? { ownerEmail: acct.ownerEmail } : {}) }),
        });
        if (res.ok) {
          const saved = await res.json();
          if (acct.ownerEmail !== saved.ownerEmail || acct.ytdSpend !== saved.ytdSpend) changedFromServer = true;
          acct.ownerEmail = saved.ownerEmail;
          acct.ytdSpend = saved.ytdSpend;
          synced[acct.id] = body;
        } else if (res.status === 403) {
          failed = `You no longer own ${acct.company}; its changes weren't saved to the server.`;
          synced[acct.id] = body; // don't retry forever
        } else {
          failed = `Couldn't save ${acct.company} to the server (${res.status}).`;
          break;
        }
      }
      const ids = new Set(state.accounts.map((a) => a.id));
      for (const id of Object.keys(synced)) {
        if (ids.has(id)) continue;
        const res = await hub.api.fetch(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (res.ok || res.status === 404) delete synced[id];
        else failed = `Couldn't delete an account on the server (${res.status}).`;
      }
    } catch (err) {
      failed = `Offline — account changes are saved here and will sync when the server is reachable (${err.message}).`;
    } finally {
      pushing = false;
      persist();
    }
    if (failed) setStatus(failed, "warn");
    else setStatus(`Accounts synced ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`, "ok");
    if (changedFromServer) hub.save();
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
  setInterval(() => hub.auth && pull(), PULL_EVERY_MS);

  hub.sync = { pull, push, isMine: (acct) => !!acct && !acct.limited };
  if (hub.auth) pull();
})();
