// Shared state for every VectorSales tab (leads, quotes, accounts), persisted to
// this browser's localStorage. Tabs call SalesHub.save() after changing
// SalesHub.state and subscribe with SalesHub.on() to re-render when another
// tab changes something.
//
// What lives where (see docs/OPERATIONS.md):
// - leads and accounts are also kept on the server by sync.js, which is what
//   shares them across devices and people;
// - quotes, the item catalog, settings and the rep profile exist ONLY in this
//   browser, so they are not shared across devices and are lost if the browser's
//   data is cleared. The Backup dialog (backup.js) downloads and restores them.
//
// Safety rules this file enforces:
// - data that can't be read is set aside, never overwritten;
// - data saved by a newer version of the app is never overwritten by an older one;
// - a failed save (storage full or blocked) is shown, not swallowed;
// - when a different person signs in on the same browser, the previous
//   person's local data is stashed under their own key (not shown, not deleted).
window.SalesHub = (function () {
  const calc = window.SalesCalc;
  const STORE_KEY = "ob.prospecting.v1"; // kept from the original Prospecting tab
  const SCHEMA_VERSION = 2;
  const stashKey = (email) => `${STORE_KEY}.user.${String(email).toLowerCase()}`;
  const CORRUPT_PREFIX = `${STORE_KEY}.corrupt.`;
  const UNDO_KEY = `${STORE_KEY}.before-restore`;
  const CATALOG_KEY = "ob.catalog.v1"; // owned by catalog.js; follows the same person as the rest
  const catalogStashKey = (email) => `${CATALOG_KEY}.user.${String(email).toLowerCase()}`;
  const switchHooks = []; // run after a different person's data was swapped in

  const defaults = () => ({
    schemaVersion: SCHEMA_VERSION,
    localOwner: "", // email of the person this browser's local data belongs to
    leads: [],
    playbook: {},
    quotes: [],
    accounts: [],
    counters: {},
    activeLeadId: null,
    activeDeal: null, // { kind: "lead" | "account", id } — the deal bar's current deal
    lastComparison: null, // latest Cost Comparison result, for adding lines to quotes
    profile: {}, // rep details printed on proposals
    settings: {}, // user preferences, e.g. targetMargin for the margin calculator
  });
  const state = defaults();
  const ARRAYS = ["leads", "quotes", "accounts"];
  const OBJECTS = ["playbook", "counters", "profile", "settings"];

  // --- Notices (shown by backup.js in a banner) --------------------------------

  const notices = new Map(); // id -> { text, tone }
  const noticeListeners = [];
  function notify(id, text, tone = "warn") {
    if (text) notices.set(id, { text, tone });
    else notices.delete(id);
    for (const fn of noticeListeners) fn();
  }

  // --- Reading what's stored ----------------------------------------------------

  let readOnly = false; // saved by a newer version: keep hands off
  let storageBlocked = false;

  const storage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch (_) {
        storageBlocked = true;
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (_) {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch (_) {
        // storage unavailable
      }
    },
    keys() {
      try {
        return Object.keys(localStorage);
      } catch (_) {
        return [];
      }
    },
  };

  // Brings stored data up to the current shape. Never drops data: anything of the
  // wrong type is returned in `rejected` so the caller can keep a copy.
  const MIGRATIONS = {
    // v1 (no version field) -> v2: adds the version and owner fields
    1: (s) => ({ ...s, schemaVersion: 2, localOwner: s.localOwner || "" }),
  };

  function normalize(saved) {
    const rejected = {};
    let data = { ...saved };
    let version = Number.isInteger(data.schemaVersion) ? data.schemaVersion : 1;
    while (version < SCHEMA_VERSION) {
      data = MIGRATIONS[version](data);
      version = data.schemaVersion;
    }
    const out = defaults();
    for (const key of Object.keys(out)) {
      if (data[key] === undefined || data[key] === null) continue;
      if (ARRAYS.includes(key) && !Array.isArray(data[key])) rejected[key] = data[key];
      else if (OBJECTS.includes(key) && (typeof data[key] !== "object" || Array.isArray(data[key]))) rejected[key] = data[key];
      else out[key] = data[key];
    }
    // Records must be objects with an id; keep the others aside rather than crash a tab later.
    for (const key of ARRAYS) {
      const bad = out[key].filter((r) => !r || typeof r !== "object" || Array.isArray(r));
      if (bad.length) {
        rejected[`${key}(unusable entries)`] = bad;
        out[key] = out[key].filter((r) => r && typeof r === "object" && !Array.isArray(r));
      }
    }
    return { data: out, rejected };
  }

  function setAside(raw, reason) {
    const key = `${CORRUPT_PREFIX}${Date.now()}`;
    const kept = storage.set(key, typeof raw === "string" ? raw : JSON.stringify(raw));
    return { key, kept, reason };
  }

  function replaceState(next) {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, next);
  }

  function load() {
    const raw = storage.get(STORE_KEY);
    if (storageBlocked) {
      notify("storage", "This browser is blocking storage (private window or blocked site data). Your work can't be saved here and will be lost when you close the tab — download a backup before leaving.", "err");
      return;
    }
    if (raw === null) return;
    let saved;
    try {
      saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw new Error("not an object");
    } catch (_) {
      const aside = setAside(raw, "unreadable");
      notify("corrupt", aside.kept
        ? "The data saved in this browser couldn't be read, so VectorSales started empty. A copy of the unreadable data was kept — open Backup to download it."
        : "The data saved in this browser couldn't be read and storage is full, so no copy could be kept. Open Backup to download what is left.", "err");
      // The unreadable value stays under STORE_KEY until the first successful save of new data replaces it,
      // which is safe now that a copy exists; if the copy failed, don't overwrite it.
      if (!aside.kept) readOnly = true;
      return;
    }
    if (Number.isInteger(saved.schemaVersion) && saved.schemaVersion > SCHEMA_VERSION) {
      readOnly = true;
      notify("newer", "This browser's data was saved by a newer version of VectorSales. This older page will not change it — refresh to load the current version.", "err");
      Object.assign(state, normalize({ ...saved, schemaVersion: SCHEMA_VERSION }).data);
      return;
    }
    const { data, rejected } = normalize(saved);
    replaceState(data);
    if (Object.keys(rejected).length) {
      setAside(rejected, "unusable fields");
      notify("partial", `Some saved data had an unexpected format (${Object.keys(rejected).join(", ")}) and was set aside. Everything else loaded. Open Backup if you need the set-aside copy.`, "warn");
    }
  }
  load();

  // --- Saving -------------------------------------------------------------------

  const listeners = [];
  let lastSaveOk = true;
  let lastSavedAt = null;

  function persist() {
    if (readOnly) return false;
    const ok = storage.set(STORE_KEY, JSON.stringify(state));
    lastSaveOk = ok;
    if (ok) lastSavedAt = new Date();
    notify("save", ok ? "" : "Your latest changes could not be saved in this browser (storage is full or blocked). They will be lost if you close or refresh this page — open Backup and download a copy now.", "err");
    return ok;
  }

  function save() {
    persist();
    for (const fn of listeners) fn();
  }

  window.addEventListener("beforeunload", (e) => {
    if (!lastSaveOk) e.preventDefault();
  });

  // --- Switching people on a shared browser ---------------------------------------

  // Called by auth.js right after a successful sign-in. Local data belongs to one
  // person; if someone else signs in, theirs is put aside (and restored when they
  // return). The first person to sign in claims data that predates this feature.
  // Returns false if the previous person's data couldn't be set aside safely.
  function adoptUser(email) {
    email = String(email || "").toLowerCase();
    if (!email) return true;
    const owner = String(state.localOwner || "").toLowerCase();
    if (!owner) {
      state.localOwner = email;
      persist();
      return true;
    }
    if (owner === email) return true;
    if (readOnly) return false;
    if (!storage.set(stashKey(owner), JSON.stringify({ ...state, localOwner: owner }))) return false;
    const catalogRaw = storage.get(CATALOG_KEY);
    if (catalogRaw !== null && !storage.set(catalogStashKey(owner), catalogRaw)) {
      storage.remove(stashKey(owner)); // undo, so nothing is half-moved
      return false;
    }
    storage.remove(CATALOG_KEY);
    const theirCatalog = storage.get(catalogStashKey(email));
    if (theirCatalog !== null) {
      storage.set(CATALOG_KEY, theirCatalog);
      storage.remove(catalogStashKey(email));
    }
    const mine = storage.get(stashKey(email));
    let next = defaults();
    if (mine) {
      try {
        next = normalize(JSON.parse(mine)).data;
      } catch (_) {
        setAside(mine, "unreadable stash");
      }
    }
    next.localOwner = email;
    replaceState(next);
    storage.remove(stashKey(email));
    persist();
    for (const fn of switchHooks) fn();
    for (const fn of listeners) fn();
    return true;
  }

  // --- Small shared helpers -------------------------------------------------------

  const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function nextNumber(kind, prefix) {
    const year = new Date().getFullYear();
    const key = `${kind}-${year}`;
    state.counters[key] = (state.counters[key] || 0) + 1;
    return `${prefix}-${year}-${String(state.counters[key]).padStart(3, "0")}`;
  }

  function downloadBlob(filename, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Exports. Cells that start with = + - @ are made safe for Excel (calc.csvCell).
  function downloadCsv(filename, header, rows) {
    const lines = [header.map(calc.csvCell).join(",")];
    for (const r of rows) lines.push(r.map(calc.csvCell).join(","));
    downloadBlob(filename, new Blob([lines.join("\r\n")], { type: "text/csv" }));
  }

  const money = (n) =>
    (Number(n) < 0 ? "−$" : "$") +
    Math.abs(Number(n || 0)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const today = () => calc.localDate();
  const addDays = calc.addDays;

  const fmtDate = (iso) => {
    const d = calc.toLocalDate(iso);
    return d ? new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
  };

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  return {
    state,
    save,
    on: (fn) => listeners.push(fn),
    newId,
    nextNumber,
    downloadCsv,
    downloadBlob,
    money,
    today,
    addDays,
    fmtDate,
    esc,
    calc,
    ref: {}, // reference data (regions, segments, product lines, stages) — filled by prospecting.js
    // Used by backup.js, auth.js and sync.js
    persistence: {
      SCHEMA_VERSION, STORE_KEY, UNDO_KEY, CORRUPT_PREFIX, storage, notices, notify, normalize, replaceState, defaults, adoptUser, setAside,
      onNotice: (fn) => noticeListeners.push(fn),
      onUserSwitch: (fn) => switchHooks.push(fn),
      CATALOG_KEY,
      status: () => ({ ok: lastSaveOk, savedAt: lastSavedAt, readOnly, blocked: storageBlocked }),
      persist,
    },
  };
})();
