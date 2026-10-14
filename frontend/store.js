// Shared state for every Sales Hub tab (leads, quotes, accounts), persisted to
// this browser's localStorage. Tabs call SalesHub.save() after changing
// SalesHub.state and subscribe with SalesHub.on() to re-render when another
// tab changes something.
window.SalesHub = (function () {
  const STORE_KEY = "ob.prospecting.v1"; // kept from the original Prospecting tab

  const state = {
    leads: [],
    playbook: {},
    quotes: [],
    accounts: [],
    counters: {},
    activeLeadId: null,
    lastComparison: null, // latest Cost Comparison result, for adding lines to quotes
    profile: {}, // rep details printed on proposals
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (saved && typeof saved === "object") {
      for (const key of Object.keys(state)) {
        if (saved[key] !== undefined && saved[key] !== null) state[key] = saved[key];
      }
    }
  } catch (_) {
    // storage unavailable or corrupt — start empty
  }

  const listeners = [];

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (_) {
      // private mode / quota — the session still works, it just won't persist
    }
    for (const fn of listeners) fn();
  }

  const newId = (prefix) => prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  function nextNumber(kind, prefix) {
    const year = new Date().getFullYear();
    const key = `${kind}-${year}`;
    state.counters[key] = (state.counters[key] || 0) + 1;
    return `${prefix}-${year}-${String(state.counters[key]).padStart(3, "0")}`;
  }

  const csvCell = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  function downloadCsv(filename, header, rows) {
    const lines = [header.map(csvCell).join(",")];
    for (const r of rows) lines.push(r.map(csvCell).join(","));
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/csv" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const money = (n) =>
    "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const today = () => new Date().toISOString().slice(0, 10);

  function addDays(isoDate, days) {
    const d = new Date(`${isoDate}T12:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    return d.toISOString().slice(0, 10);
  }

  const fmtDate = (iso) =>
    iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  return {
    state,
    save,
    on: (fn) => listeners.push(fn),
    newId,
    nextNumber,
    downloadCsv,
    money,
    today,
    addDays,
    fmtDate,
    esc,
    ref: {}, // reference data (regions, segments, product lines, stages) — filled by prospecting.js
  };
})();
