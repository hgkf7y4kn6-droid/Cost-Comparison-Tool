// Backup & restore for the data that lives only in this browser, plus the
// banner that reports storage problems (see store.js).
//
// A backup file holds leads, quotes, accounts, settings and the item catalog.
// It includes supplier costs and margins, so treat it as confidential. Leads and
// accounts are also on the server (sync.js); quotes and the catalog are not, so
// this file is their only copy outside this browser.
//
// Restoring never overwrites silently: the file is validated first, the current
// data is snapshotted (one level of undo), and "add missing" only adds records
// whose ids don't exist yet.
(function () {
  const hub = window.SalesHub;
  const P = hub.persistence;
  const $ = (id) => document.getElementById(id);
  const FORMAT = "sales-hub-backup";
  const MAX_BACKUP_BYTES = 40 * 1024 * 1024;
  const LISTS = ["leads", "quotes", "accounts"];
  const DICTS = ["playbook", "counters", "profile", "settings"];

  // --- Banner ------------------------------------------------------------------

  function renderNotices() {
    const box = $("storage-notice");
    const items = [...P.notices.values()];
    box.hidden = items.length === 0;
    box.replaceChildren();
    for (const n of items) {
      const p = document.createElement("p");
      p.className = n.tone === "err" ? "status err" : "status";
      p.textContent = n.text;
      box.append(p);
    }
    if (items.length) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn small";
      b.textContent = "Open Backup";
      b.addEventListener("click", openDialog);
      box.append(b);
    }
  }
  P.onNotice(renderNotices);

  // --- Building and validating backups -------------------------------------------

  function catalogRaw() {
    const raw = P.storage.get(P.CATALOG_KEY);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function buildBackup() {
    const s = hub.state;
    return {
      app: FORMAT,
      formatVersion: 1,
      schemaVersion: P.SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      owner: (hub.auth && hub.auth.email) || s.localOwner || "",
      confidential: "Includes supplier costs, margins and customer details. Store it securely.",
      data: Object.fromEntries([...LISTS, ...DICTS].map((k) => [k, s[k]])),
      catalog: catalogRaw(),
    };
  }

  // Returns { ok, errors, summary, data, catalog }. Nothing is changed.
  function validateBackup(obj) {
    const errors = [];
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || obj.app !== FORMAT) {
      return { ok: false, errors: ["This isn't a VectorSales backup file."] };
    }
    if (!Number.isInteger(obj.schemaVersion) || obj.schemaVersion < 1) errors.push("The backup has no valid version number.");
    else if (obj.schemaVersion > P.SCHEMA_VERSION) errors.push("This backup was made by a newer version of VectorSales. Refresh the page to update, then try again.");
    const data = obj.data;
    if (!data || typeof data !== "object") return { ok: false, errors: [...errors, "The backup has no data section."] };
    const clean = {};
    for (const k of LISTS) {
      const list = data[k] === undefined ? [] : data[k];
      if (!Array.isArray(list)) {
        errors.push(`"${k}" should be a list.`);
        continue;
      }
      const bad = list.findIndex((r) => !r || typeof r !== "object" || Array.isArray(r) || typeof r.id !== "string" || !r.id);
      if (bad >= 0) errors.push(`${k}: entry ${bad + 1} has no id, so it can't be restored safely.`);
      const ids = new Set();
      for (const r of list) {
        if (r && ids.has(r.id)) {
          errors.push(`${k}: the id "${r.id}" appears more than once.`);
          break;
        }
        if (r) ids.add(r.id);
      }
      clean[k] = list;
    }
    for (const k of DICTS) {
      const v = data[k] === undefined ? {} : data[k];
      if (!v || typeof v !== "object" || Array.isArray(v)) errors.push(`"${k}" should be an object.`);
      else clean[k] = v;
    }
    let catalog = null;
    if (obj.catalog !== null && obj.catalog !== undefined) {
      if (obj.catalog && Array.isArray(obj.catalog.items)) catalog = obj.catalog;
      else errors.push("The item catalog section is malformed.");
    }
    return {
      ok: errors.length === 0,
      errors,
      data: clean,
      catalog,
      owner: typeof obj.owner === "string" ? obj.owner : "",
      exportedAt: obj.exportedAt,
      summary: { leads: (clean.leads || []).length, quotes: (clean.quotes || []).length, accounts: (clean.accounts || []).length, catalogItems: catalog ? catalog.items.length : 0 },
    };
  }

  // Saves what's there now so a restore can be undone (one level).
  function snapshotForUndo() {
    const snap = JSON.stringify({ takenAt: new Date().toISOString(), state: hub.state, catalog: P.storage.get(P.CATALOG_KEY) });
    return P.storage.set(P.UNDO_KEY, snap);
  }

  function applyRestore(v, mode) {
    if (!snapshotForUndo()) return "Couldn't set aside a copy of your current data to allow undo (storage is full), so nothing was changed. Download a backup first.";
    const s = hub.state;
    if (mode === "replace") {
      const next = { ...P.defaults(), ...v.data, localOwner: s.localOwner, schemaVersion: P.SCHEMA_VERSION };
      P.replaceState(next);
      if (v.catalog) P.storage.set(P.CATALOG_KEY, JSON.stringify(v.catalog));
    } else {
      for (const k of LISTS) {
        const have = new Set(s[k].map((r) => r.id));
        for (const r of v.data[k] || []) if (!have.has(r.id)) s[k].push(r);
      }
      if (v.catalog && !P.storage.get(P.CATALOG_KEY)) P.storage.set(P.CATALOG_KEY, JSON.stringify(v.catalog));
    }
    hub.save();
    return "";
  }

  function undoRestore() {
    const raw = P.storage.get(P.UNDO_KEY);
    if (!raw) return "There's nothing to undo.";
    try {
      const snap = JSON.parse(raw);
      const next = P.normalize(snap.state).data;
      P.replaceState(next);
      if (snap.catalog) P.storage.set(P.CATALOG_KEY, snap.catalog);
      else P.storage.remove(P.CATALOG_KEY);
      P.storage.remove(P.UNDO_KEY);
      hub.save();
      return "";
    } catch (_) {
      return "The saved copy couldn't be read, so nothing was changed.";
    }
  }

  // --- Dialog -------------------------------------------------------------------

  let opener = null;
  let pending = null; // validated backup waiting for a choice

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function corruptCopies() {
    return P.storage.keys().filter((k) => k.startsWith(P.CORRUPT_PREFIX)).sort();
  }

  function render() {
    const body = $("backup-body");
    body.replaceChildren();
    const st = P.status();
    const s = hub.state;

    const where = el("div", "acct-section");
    where.append(el("h4", "", "What's saved where"));
    const ul = el("ul", "plain-list");
    for (const t of [
      "Leads and accounts: saved in this browser and synced to the server, so they follow you across devices.",
      hub.state.settings && hub.state.settings.syncQuotes === true
        ? "Proposals: also saved to the server for you alone (supplier costs and margins included), so they follow you across devices."
        : "Proposals: saved in this browser only unless you choose “Save my proposals to the server” on the Proposals tab. Until then they are lost if this browser's site data is cleared.",
      "The item catalog, your profile and settings: saved in this browser only. They are not shared across devices or with teammates. Download a backup regularly.",
    ]) ul.append(el("li", "", t));
    where.append(ul);
    where.append(el("p", "hint", `Right now: ${s.leads.length} leads · ${s.quotes.length} proposals · ${s.accounts.length} accounts. ${st.blocked ? "This browser is blocking storage." : st.ok ? (st.savedAt ? `Last saved ${st.savedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : "Saved.") : "The last save FAILED."}`));
    body.append(where);

    const dl = el("div", "acct-section");
    dl.append(el("h4", "", "Download a backup"));
    dl.append(el("p", "hint", "Includes supplier costs, margins and customer details — keep the file somewhere secure and don't email it."));
    const dlBtn = el("button", "btn small primary", "Download backup (.json)");
    dlBtn.type = "button";
    dlBtn.addEventListener("click", () => {
      hub.downloadBlob(`vectorsales-backup-${hub.today()}.json`, new Blob([JSON.stringify(buildBackup(), null, 2)], { type: "application/json" }));
      $("backup-msg").textContent = "Backup downloaded.";
    });
    dl.append(dlBtn);
    body.append(dl);

    const rs = el("div", "acct-section");
    rs.append(el("h4", "", "Restore from a backup"));
    const label = el("label", "");
    label.textContent = "Backup file ";
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".json,application/json";
    label.append(file);
    rs.append(label);
    const preview = el("div", "");
    preview.setAttribute("aria-live", "polite");
    rs.append(preview);
    file.addEventListener("change", async () => {
      preview.replaceChildren();
      pending = null;
      const f = file.files[0];
      if (!f) return;
      if (f.size > MAX_BACKUP_BYTES) return preview.append(el("p", "status err", "That file is too large to be a VectorSales backup."));
      let obj;
      try {
        obj = JSON.parse(await f.text());
      } catch (_) {
        return preview.append(el("p", "status err", "That file isn't readable as a backup (it isn't valid JSON). Nothing was changed."));
      }
      const v = validateBackup(obj);
      if (!v.ok) {
        for (const e of v.errors) preview.append(el("p", "status err", e));
        preview.append(el("p", "hint", "Nothing was changed."));
        return;
      }
      pending = v;
      const me = ((hub.auth && hub.auth.email) || "").toLowerCase();
      const when = v.exportedAt ? hub.fmtDate(v.exportedAt) : "unknown date";
      preview.append(el("p", "", `Backup from ${when}${v.owner ? ` by ${v.owner}` : ""}: ${v.summary.leads} leads, ${v.summary.quotes} proposals, ${v.summary.accounts} accounts, ${v.summary.catalogItems} catalog items.`));
      if (v.owner && me && v.owner.toLowerCase() !== me) preview.append(el("p", "notice", `This backup belongs to ${v.owner}, not you. Restoring it puts their customer details and costs on this account.`));
      const row = el("div", "row-buttons");
      const add = el("button", "btn small primary", "Add records that are missing");
      const rep = el("button", "btn small danger", "Replace everything on this device");
      for (const b of [add, rep]) b.type = "button";
      add.addEventListener("click", () => finish("add"));
      rep.addEventListener("click", () => {
        if (confirm("Replace ALL proposals, leads, accounts, settings and the catalog on this device with the backup? Your current data is kept for one Undo.")) finish("replace");
      });
      row.append(add, rep);
      preview.append(row, el("p", "hint", "“Add” keeps everything you have and only adds records whose ids are new. Both can be undone once."));
    });
    function finish(mode) {
      const err = applyRestore(pending, mode);
      $("backup-msg").textContent = err || (mode === "replace" ? "Restored. Use Undo if that wasn't what you wanted." : "Added the missing records. Use Undo if that wasn't what you wanted.");
      $("backup-msg").className = err ? "status err" : "status ok";
      pending = null;
      render();
    }
    body.append(rs);

    if (P.storage.get(P.UNDO_KEY)) {
      const un = el("div", "acct-section");
      un.append(el("h4", "", "Undo the last restore"));
      const b = el("button", "btn small", "Undo last restore");
      b.type = "button";
      b.addEventListener("click", () => {
        const err = undoRestore();
        $("backup-msg").textContent = err || "Restored the data you had before the last restore.";
        $("backup-msg").className = err ? "status err" : "status ok";
        render();
      });
      un.append(b);
      body.append(un);
    }

    const copies = corruptCopies();
    if (copies.length) {
      const c = el("div", "acct-section");
      c.append(el("h4", "", "Set-aside copies"));
      c.append(el("p", "hint", "Data this browser held that couldn't be loaded was kept here instead of being thrown away. Download it and ask for help recovering it."));
      for (const key of copies) {
        const when = new Date(Number(key.slice(P.CORRUPT_PREFIX.length)));
        const b = el("button", "btn small", `Download copy from ${Number.isNaN(when.getTime()) ? key : when.toLocaleString()}`);
        b.type = "button";
        b.addEventListener("click", () => hub.downloadBlob(`vectorsales-unreadable-${key.slice(P.CORRUPT_PREFIX.length)}.txt`, new Blob([P.storage.get(key) || ""], { type: "text/plain" })));
        c.append(b);
      }
      body.append(c);
    }

    if (hub.auth && hub.auth.role === "manager") {
      const sv = el("div", "acct-section");
      sv.append(el("h4", "", "Server export (managers)"));
      sv.append(el("p", "hint", "Every lead, account and proposal on the server, with full customer detail. This is the off-site copy: download weekly and keep it secure."));
      const b = el("button", "btn small", "Download server export (.json)");
      b.type = "button";
      b.addEventListener("click", async () => {
        $("backup-msg").className = "status";
        try {
          const res = await hub.api.fetch("/records/export");
          if (!res.ok) throw new Error(`The server said ${res.status}.`);
          hub.downloadBlob(`vectorsales-server-export-${hub.today()}.json`, await res.blob());
          $("backup-msg").textContent = "Server export downloaded.";
        } catch (err) {
          $("backup-msg").className = "status err";
          $("backup-msg").textContent = `Couldn't download the server export. ${err.message}`;
        }
      });
      sv.append(b);
      body.append(sv);
    }

    const conflicts = hub.sync ? hub.sync.conflicts() : [];
    if (conflicts.length) {
      const c = el("div", "acct-section");
      c.append(el("h4", "", "Edits replaced by newer changes"));
      c.append(el("p", "hint", `${conflicts.length} edit${conflicts.length === 1 ? " was" : "s were"} not saved because someone else changed the same record first. Your version is kept here so nothing is lost; copy anything you still need into the record.`));
      const b = el("button", "btn small", "Download these edits (.json)");
      b.type = "button";
      b.addEventListener("click", () => hub.downloadBlob(`vectorsales-replaced-edits-${hub.today()}.json`, new Blob([JSON.stringify(conflicts, null, 2)], { type: "application/json" })));
      const clear = el("button", "btn small", "Clear this list");
      clear.type = "button";
      clear.addEventListener("click", () => {
        if (confirm("Clear the saved copies of replaced edits?")) {
          hub.sync.clearConflicts();
          render();
        }
      });
      c.append(b, clear);
      body.append(c);
    }

    const rm = el("div", "acct-section");
    rm.append(el("h4", "", "Remove my data from this browser"));
    rm.append(el("p", "hint", "Use on a shared or borrowed computer. Leads and accounts stay safe on the server; proposals and the catalog are deleted from this device, so download a backup first."));
    const rmBtn = el("button", "btn small danger", "Remove data and sign out");
    rmBtn.type = "button";
    rmBtn.addEventListener("click", () => {
      if (!confirm("Delete the proposals, catalog, settings and cached leads/accounts stored in this browser? This cannot be undone. (Leads and accounts remain on the server.)")) return;
      for (const k of P.storage.keys()) if (k.startsWith("ob.")) P.storage.remove(k);
      location.reload();
    });
    rm.append(rmBtn);
    body.append(rm);
  }

  function openDialog() {
    opener = document.activeElement;
    $("backup-msg").textContent = "";
    $("backup-msg").className = "status";
    pending = null;
    render();
    $("backup-modal").hidden = false;
    document.body.classList.add("modal-open");
    setTimeout(() => $("backup-close").focus(), 0);
  }

  function closeDialog() {
    $("backup-modal").hidden = true;
    document.body.classList.remove("modal-open");
    if (opener && opener.focus) opener.focus();
  }

  $("backup-open").addEventListener("click", openDialog);
  $("backup-close").addEventListener("click", closeDialog);
  $("backup-modal").addEventListener("click", (e) => {
    if (e.target === $("backup-modal")) closeDialog();
  });
  document.addEventListener("keydown", (e) => {
    if ($("backup-modal").hidden) return;
    if (e.key === "Escape") {
      e.stopImmediatePropagation();
      closeDialog();
    } else if (e.key === "Tab") {
      // keep focus inside the dialog
      const f = [...$("backup-modal").querySelectorAll("button, input, a[href]")].filter((n) => !n.disabled && n.offsetParent !== null);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, true);

  hub.backup = { build: buildBackup, validate: validateBackup, apply: applyRestore, undo: undoRestore, open: openDialog };
  renderNotices();
})();
