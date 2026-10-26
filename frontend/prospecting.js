// Prospecting tab: import, clean, score and work regional B2B leads.
// Leads live in the shared SalesHub store (store.js); export CSV to back up or share.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;

  // --- Reference data -------------------------------------------------------

  const REGIONS = {
    philadelphia: "Philadelphia",
    lehigh: "Allentown / Lehigh Valley",
    lancaster: "Lancaster",
    nj: "New Jersey",
    other: "Out of territory",
  };

  const COUNTY_REGION = {
    philadelphia: "philadelphia", bucks: "philadelphia", montgomery: "philadelphia",
    delaware: "philadelphia", chester: "philadelphia",
    lehigh: "lehigh", northampton: "lehigh",
    lancaster: "lancaster",
    camden: "nj", burlington: "nj", mercer: "nj", gloucester: "nj", salem: "nj",
    cumberland: "nj", atlantic: "nj", ocean: "nj", monmouth: "nj", middlesex: "nj",
    somerset: "nj", hunterdon: "nj",
  };

  const CITY_REGION = {
    philadelphia: "philadelphia", "king of prussia": "philadelphia", conshohocken: "philadelphia",
    norristown: "philadelphia", "media": "philadelphia", "west chester": "philadelphia",
    allentown: "lehigh", bethlehem: "lehigh", easton: "lehigh", whitehall: "lehigh",
    emmaus: "lehigh", "center valley": "lehigh", "breinigsville": "lehigh", fogelsville: "lehigh",
    lancaster: "lancaster", lititz: "lancaster", ephrata: "lancaster", "elizabethtown": "lancaster",
    "mount joy": "lancaster", "manheim": "lancaster", leola: "lancaster", "new holland": "lancaster",
    camden: "nj", "cherry hill": "nj", trenton: "nj", princeton: "nj", "mount laurel": "nj",
    "moorestown": "nj", "marlton": "nj", "voorhees": "nj", "pennsauken": "nj", "ewing": "nj",
  };

  // County is the most reliable signal (state registries publish it), then ZIP
  // prefix (Google Maps exports), then city. Several county names exist in both
  // PA and NJ, so a county match must agree with the state when one is given.
  function regionFor(lead) {
    const state = (lead.state || "").trim().toUpperCase();
    const county = (lead.county || "").toLowerCase().replace(/\s+county$/, "").trim();
    const city = (lead.city || "").toLowerCase().trim();
    const zip = (lead.zip || "").trim().padStart(5, "0").slice(0, 5);
    const z3 = Number(zip.slice(0, 3));

    if (county && COUNTY_REGION[county]) {
      const r = COUNTY_REGION[county];
      if (!state || (r === "nj") === (state === "NJ")) return r;
    }
    if (/^\d{5}$/.test(zip) && zip !== "00000") {
      if (z3 >= 190 && z3 <= 191) return "philadelphia";
      if (z3 >= 180 && z3 <= 181) return "lehigh";
      if (z3 >= 175 && z3 <= 176) return "lancaster";
      if (z3 >= 80 && z3 <= 86) return "nj";
    }
    if (city && CITY_REGION[city]) return CITY_REGION[city];
    if (state === "NJ") return "nj";
    return "other";
  }

  const SEGMENTS = {
    healthcare: {
      label: "Healthcare / medical",
      audience: "healthcare providers",
      keywords: ["health", "medical", "hospital", "clinic", "dental", "physician", "pharma",
        "rehab*", "nursing", "hospice", "senior living", "surg*", "orthopedic*", "pediatric*",
        "therap*", "urgent care", "home care"],
      products: ["apparel", "janitorial", "furniture"],
    },
    property: {
      label: "Property mgmt / CRE",
      audience: "property managers",
      keywords: ["property", "properties", "realty", "real estate", "leasing", "realtors",
        "commercial real", "building management", "facilities management"],
      products: ["janitorial", "furniture"],
    },
    industrial: {
      label: "Hospitality / distribution / mfg",
      audience: "distribution, manufacturing and hospitality teams",
      keywords: ["warehous*", "logistics", "distribution", "manufactur*", "hotel*", "hospitality",
        "restaurant*", "food*", "packaging", "freight", "fabricat*", "industrial", "supply",
        "trucking", "brewing", "brewery"],
      products: ["apparel", "janitorial", "furniture"],
    },
    corporate: {
      label: "Corporate / professional",
      audience: "professional services firms",
      keywords: ["law", "legal", "attorney", "accounting", "cpa", "financial", "insurance",
        "bank*", "consult*", "software", "technolog*", "engineering", "marketing", "agency",
        "capital", "advisor*", "partners", "group", "solutions", "services", "architect*"],
      products: ["furniture", "apparel", "janitorial"],
    },
    other: { label: "Unclassified", audience: "businesses", keywords: [], products: [] },
  };

  const PRODUCTS = {
    furniture: {
      label: "Office furniture & design",
      titles: ["Director of Facilities", "VP of Real Estate / Operations", "Office Manager / Workplace Experience"],
      why: "They oversee office moves, space layouts, and major furniture renovations.",
      pitch: "office furniture",
    },
    janitorial: {
      label: "Janitorial & facility supplies",
      titles: ["Facilities Manager", "Operations Manager", "Procurement Specialist"],
      why: "They manage day-to-day building upkeep and order cleaning/restocking supplies.",
      pitch: "janitorial supply",
    },
    apparel: {
      label: "Uniforms & corporate apparel",
      titles: ["HR Director", "Marketing Manager (Corporate)", "Operations Lead (Field/Techs)"],
      why: "HR coordinates employee apparel programs; Marketing handles corporate branding.",
      pitch: "uniform & apparel",
    },
  };

  const TRIGGERS = {
    newOffice: "Opened / opening a new location",
    facilitiesHire: "Hiring Facilities Manager / Office Admin",
    relocation: "HQ relocation in local business news",
    uniformedTeam: "Field techs / uniformed on-site team",
  };

  const STAGES = {
    new: "New",
    enriched: "Enriched",
    verified: "Verified",
    contacted: "Contacted",
    qualified: "Qualified",
    proposal: "Proposal sent",
    won: "Won",
    disqualified: "Disqualified",
  };

  const CONSUMER_DOMAINS = new Set([
    "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com", "hotmail.com",
    "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com",
    "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net",
    "charter.net", "optonline.net", "earthlink.net", "protonmail.com", "proton.me",
    "gmx.com", "mail.com", "zoho.com", "yandex.com", "ptd.net", "rcn.com", "juno.com",
  ]);

  const HEADCOUNT_MIN = 20;
  const HEADCOUNT_MAX = 500;

  // --- Storage --------------------------------------------------------------

  const state = hub.state;
  const save = hub.save;
  let openId = null; // lead shown in the detail panel

  const newId = () => hub.newId("L");

  // --- Lead helpers ---------------------------------------------------------

  function emailDomain(email) {
    const at = (email || "").lastIndexOf("@");
    return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
  }
  const isConsumerEmail = (email) => CONSUMER_DOMAINS.has(emailDomain(email));

  function classifySegment(lead) {
    const text = `${lead.industry || ""} ${lead.company || ""}`.toLowerCase();
    for (const key of ["healthcare", "property", "industrial", "corporate"]) {
      // Whole-word match so "law" doesn't hit "lawn"; a trailing * marks a stem.
      if (SEGMENTS[key].keywords.some((k) => new RegExp(`\\b${k.replace("*", "\\w*")}\\b`).test(text))) return key;
    }
    return "other";
  }

  function sizeBand(lead) {
    const n = Number(lead.employees);
    if (!lead.employees && lead.employees !== 0) return "unknown";
    if (!Number.isFinite(n)) return "unknown";
    return n >= HEADCOUNT_MIN && n <= HEADCOUNT_MAX ? "in" : "out";
  }

  function fitScore(lead) {
    let score = 0;
    if (lead.region && lead.region !== "other") score += 20;
    const band = sizeBand(lead);
    score += band === "in" ? 25 : band === "unknown" ? 10 : 0;
    if (lead.segment && lead.segment !== "other") score += 20;
    if (lead.email && lead.emailStatus !== "invalid") score += lead.emailStatus === "valid" ? 10 : 5;
    if (lead.contactName || lead.contactTitle) score += 5;
    const triggers = Object.values(lead.triggers || {}).filter(Boolean).length;
    score += Math.min(20, triggers * 7);
    return Math.min(100, score);
  }

  function companyKey(lead) {
    const name = (lead.company || "").toLowerCase()
      .replace(/[.,'"&]/g, " ")
      .replace(/\b(inc|llc|l l c|corp|corporation|co|company|ltd|lp|llp|pc|pllc|the)\b/g, " ")
      .replace(/\s+/g, " ").trim();
    const where = (lead.zip || "").slice(0, 5) || (lead.city || "").toLowerCase().trim();
    return `${name}|${where}`;
  }

  function parseEmployees(value) {
    if (value === undefined || value === null || value === "") return "";
    const nums = String(value).replace(/,/g, "").match(/\d+/g);
    if (!nums) return "";
    if (nums.length >= 2) return Math.round((Number(nums[0]) + Number(nums[1])) / 2);
    return Number(nums[0]);
  }

  function normalizeLead(lead) {
    lead.region = lead.region || regionFor(lead);
    lead.segment = lead.segment || classifySegment(lead);
    if (!Array.isArray(lead.products) || !lead.products.length) {
      lead.products = [...(SEGMENTS[lead.segment] || SEGMENTS.other).products];
    }
    lead.triggers = lead.triggers || {};
    lead.stage = STAGES[lead.stage] ? lead.stage : "new";
    lead.emailStatus = lead.emailStatus || "unverified";
    lead.score = fitScore(lead);
    return lead;
  }

  // --- CSV ------------------------------------------------------------------

  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    text = text.replace(/^﻿/, "");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v.trim() !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
    row.push(field);
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    return rows;
  }

  // Header aliases, matched after lowercasing and stripping non-alphanumerics.
  // Earlier aliases win, so specific names beat generic ones like "name".
  const FIELD_ALIASES = {
    id: ["id", "leadid"],
    company: ["company", "companyname", "businessname", "entityname", "legalname", "organization",
      "organizationname", "tradename", "dba", "doingbusinessas", "account", "accountname", "name"],
    address: ["address", "streetaddress", "address1", "street", "businessaddress", "fulladdress", "location"],
    city: ["city", "municipality", "town"],
    county: ["county", "countyname"],
    state: ["state", "st", "stateprovince"],
    zip: ["zip", "zipcode", "postalcode", "postal"],
    industry: ["industry", "naicsdescription", "category", "businesstype", "licensetype", "type",
      "sicdescription", "naics", "description"],
    employees: ["employees", "employeecount", "numberofemployees", "estimatednumemployees",
      "headcount", "companysize", "size"],
    website: ["website", "domain", "companydomain", "url", "site"],
    email: ["email", "emailaddress", "businessemail", "workemail", "contactemail"],
    phone: ["phone", "phonenumber", "businessphone", "telephone", "companyphone"],
    contactName: ["contactname", "fullname", "contact", "person"],
    firstName: ["firstname"],
    lastName: ["lastname"],
    contactTitle: ["contacttitle", "title", "jobtitle", "position"],
    emailStatus: ["emailstatus", "verification", "verificationstatus", "zbstatus", "result"],
    source: ["source", "leadsource"],
    stage: ["stage"],
    notes: ["notes"],
  };

  function mapHeaders(headers) {
    const norm = headers.map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
    const map = {};
    const used = new Set();
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      for (const alias of aliases) {
        const idx = norm.findIndex((h, i) => h === alias && !used.has(i));
        if (idx >= 0) { map[field] = idx; used.add(idx); break; }
      }
    }
    return map;
  }

  function normalizeEmailStatus(v) {
    const s = (v || "").toLowerCase();
    if (!s) return "";
    if (/^(valid|deliverable|ok|good|verified)$/.test(s)) return "valid";
    if (/invalid|undeliverable|bounce|bad|spamtrap|abuse|do_not_mail/.test(s)) return "invalid";
    if (/catch|accept|risky|unknown/.test(s)) return "catch-all";
    return "";
  }

  // --- Import ---------------------------------------------------------------

  // Excel and PDF files are parsed by the backend (/leads/parse/); CSV is read
  // here so it keeps working without the server. Every format then goes
  // through the same review step: pick the sheet/table, skip title rows, and
  // map columns to lead fields.
  const FIELD_LABELS = {
    company: "Company", address: "Address", city: "City", county: "County", state: "State", zip: "ZIP",
    industry: "Industry", employees: "Employees", website: "Website", email: "Email", phone: "Phone",
    contactName: "Contact name", firstName: "First name", lastName: "Last name", contactTitle: "Contact title",
    emailStatus: "Email status", source: "Source", stage: "Stage", notes: "Notes", id: "Lead ID (re-import)",
  };

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const PHONE_RE = /^(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(x|ext\.?)\s*\d+)?$/i;
  const ZIP_RE = /^\d{5}(-\d{4})?$/;
  const STATE_RE = /^(PA|NJ|DE|NY|MD)$/i;
  const WEB_RE = /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|biz|us|co|io|info|health|law|pro)(\/\S*)?$/i;
  const STREET_RE = /^\d+[A-Z]?\s+\S+/i;
  const CITY_ST_ZIP_RE = /,\s*[^,]+?,?\s+[A-Z]{2}\s+\d{5}(-\d{4})?$/;
  // Directory PDFs often prefix values: "Phone: 215-…", "Email: info@…".
  const LABEL_PREFIX_RE = /^(phone|tel|telephone|ph|fax|e-?mail|web\s?site|web|url|address|addr|contact)\s*[:#]\s*/i;
  const EMPTY_RE = /^(n\/?a|none|null|-+|—)$/i;

  const STATE_NAMES = { pennsylvania: "PA", "new jersey": "NJ", delaware: "DE", "new york": "NY", maryland: "MD" };
  function normalizeState(v) {
    const s = v.trim().toLowerCase().replace(/\.$/, "");
    return STATE_NAMES[s] || (s === "penn" || s === "penna" ? "PA" : v.trim().toUpperCase().slice(0, 2));
  }

  function cleanValue(field, raw) {
    const v = String(raw ?? "").replace(LABEL_PREFIX_RE, "").trim();
    if (EMPTY_RE.test(v)) return "";
    if (field === "email") {
      const m = v.match(EMAIL_RE);
      return m ? m[0].toLowerCase() : "";
    }
    if (field === "website") return v.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    return v;
  }

  // "123 Market St, Philadelphia, PA 19103" (or "Philadelphia, PA 19103") in the
  // address column fills city/state/zip when those aren't separate columns.
  function splitAddress(lead) {
    if (!lead.address) return;
    const full = lead.address.match(/^(.+?),\s*([^,]+?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    const cityOnly = !full && lead.address.match(/^([^,\d][^,]*?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    const parts = full ? full.slice(1) : cityOnly ? ["", ...cityOnly.slice(1)] : null;
    if (!parts) return;
    const [street, city, st, zip] = parts;
    lead.address = street;
    lead.city = lead.city || city;
    lead.state = lead.state || st.toUpperCase();
    lead.zip = lead.zip || zip;
  }

  // For files without a header row: recognize columns by what's in them.
  function guessByContent(rows, width) {
    const sample = rows.slice(0, 300);
    const mapping = Array(width).fill("");
    const rate = (i, test) => {
      let n = 0, hit = 0;
      for (const r of sample) {
        const v = (r[i] || "").replace(LABEL_PREFIX_RE, "").trim();
        if (!v || EMPTY_RE.test(v)) continue;
        n++;
        if (test(v)) hit++;
      }
      return n ? hit / n : 0;
    };
    const tests = [
      ["email", (v) => EMAIL_RE.test(v)],
      ["website", (v) => WEB_RE.test(v) && !v.includes("@")],
      ["phone", (v) => PHONE_RE.test(v)],
      ["zip", (v) => ZIP_RE.test(v)],
      ["state", (v) => STATE_RE.test(v)],
      ["address", (v) => STREET_RE.test(v) || CITY_ST_ZIP_RE.test(v)],
    ];
    for (const [field, test] of tests) {
      let best = -1, bestRate = 0.5;
      for (let i = 0; i < width; i++) {
        if (mapping[i]) continue;
        const r = rate(i, test);
        if (r > bestRate) { best = i; bestRate = r; }
      }
      if (best >= 0) mapping[best] = field;
    }
    // Company: the leftmost remaining column that's mostly words, not numbers.
    for (let i = 0; i < width; i++) {
      if (!mapping[i] && rate(i, (v) => /[a-z]{2}/i.test(v) && !/^[\d\s.,()$%-]+$/.test(v)) > 0.6) {
        mapping[i] = "company";
        break;
      }
    }
    return mapping;
  }

  // Finds a header row in the first 10 rows (title rows above it are skipped);
  // otherwise falls back to guessing columns from their contents.
  function autoSetup(rows, width) {
    for (let i = 0; i < Math.min(10, rows.length - 1); i++) {
      const m = mapHeaders(rows[i]);
      if (m.company !== undefined && Object.keys(m).length >= 2) {
        const mapping = Array(width).fill("");
        for (const [f, idx] of Object.entries(m)) if (FIELD_LABELS[f]) mapping[idx] = f;
        return { skip: i, header: true, mapping };
      }
    }
    return { skip: 0, header: false, mapping: guessByContent(rows, width) };
  }

  const setupScore = (st) =>
    st.mapping.filter(Boolean).length + (st.mapping.includes("company") ? 5 : 0) + (st.header ? 1 : 0);

  async function readLeadFile(file) {
    const ext = file.name.toLowerCase().split(".").pop();
    if (ext === "csv") return [{ name: file.name, kind: "csv", rows: parseCsv(await file.text()), note: "" }];
    if (!["xlsx", "xls", "pdf"].includes(ext)) throw new Error("Use a .csv, .xlsx, .xls or .pdf file.");
    const fd = new FormData();
    fd.append("file", file);
    let res;
    try {
      res = await hub.api.fetch("/leads/parse/", { method: "POST", body: fd });
    } catch (err) {
      throw new Error(err.message.startsWith("Connection failed")
        ? `Excel and PDF files are read by the backend server, which couldn't be reached (${err.message}). CSV files still import without it.`
        : err.message);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      // non-JSON error body
    }
    if (!res.ok) throw new Error((data && typeof data.detail === "string" && data.detail) || `Server error ${res.status}`);
    return data.sheets;
  }

  let review = null; // { fileName, sheets, sheetIdx, skip, header, mapping }

  function useSheet(idx) {
    const sheet = review.sheets[idx];
    const st = autoSetup(sheet.rows, sheet.width);
    Object.assign(review, { sheetIdx: idx }, st);
  }

  $("lead-import-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("import-error").textContent = "";
    $("import-report").hidden = true;
    const file = $("lead-file").files[0];
    if (!file) return;
    const button = e.target.querySelector("button[type=submit]");
    button.disabled = true;
    button.textContent = "Reading file…";
    try {
      const sheets = (await readLeadFile(file))
        .map((s) => {
          const width = Math.max(0, ...s.rows.map((r) => r.length));
          return { ...s, width, rows: s.rows.map((r) => [...r, ...Array(width - r.length).fill("")]) };
        })
        .filter((s) => s.rows.length && s.width);
      if (!sheets.length) throw new Error("No rows found in this file.");
      review = { fileName: file.name, sheets };
      // Start on the sheet/table whose columns are recognized best.
      let best = 0, bestScore = -1;
      sheets.forEach((s, i) => {
        const score = setupScore(autoSetup(s.rows, s.width));
        if (score > bestScore) { best = i; bestScore = score; }
      });
      useSheet(best);
      renderReview();
    } catch (err) {
      $("import-error").textContent = err.message;
    } finally {
      button.disabled = false;
      button.textContent = "Read File";
    }
  });

  function reviewDataRows() {
    return review.sheets[review.sheetIdx].rows.slice(review.skip + (review.header ? 1 : 0));
  }

  const PREVIEW_ROWS = 8;

  function renderReview() {
    const sheet = review.sheets[review.sheetIdx];
    $("import-review").hidden = false;
    $("ir-file").textContent = review.fileName;

    const sel = $("ir-sheet");
    sel.replaceChildren(...review.sheets.map((s, i) => new Option(`${s.name} (${s.rows.length} rows)`, String(i))));
    sel.value = String(review.sheetIdx);
    $("ir-sheet-wrap").hidden = review.sheets.length < 2;
    $("ir-note").textContent = sheet.note || "";
    $("ir-skip").value = review.skip;
    $("ir-skip").max = Math.max(0, sheet.rows.length - 1);
    $("ir-header").checked = review.header;

    const head = $("ir-head");
    head.replaceChildren();
    const selRow = document.createElement("tr");
    for (let i = 0; i < sheet.width; i++) {
      const th = document.createElement("th");
      const s = document.createElement("select");
      s.dataset.col = i;
      s.setAttribute("aria-label", `Field for column ${i + 1}`);
      s.append(new Option("— skip —", ""));
      for (const [f, label] of Object.entries(FIELD_LABELS)) s.append(new Option(label, f));
      s.value = review.mapping[i] || "";
      if (s.value) th.className = "mapped";
      th.append(s);
      selRow.append(th);
    }
    head.append(selRow);
    if (review.header) {
      const hdr = document.createElement("tr");
      hdr.className = "hdr";
      for (const v of sheet.rows[review.skip] || []) {
        const th = document.createElement("th");
        th.textContent = v;
        hdr.append(th);
      }
      head.append(hdr);
    }

    const rows = reviewDataRows();
    const body = $("ir-body");
    body.replaceChildren();
    for (const r of rows.slice(0, PREVIEW_ROWS)) {
      const tr = document.createElement("tr");
      r.forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v;
        if (review.mapping[i]) td.className = "mapped";
        tr.append(td);
      });
      body.append(tr);
    }

    const mapped = review.mapping.map((f, i) => (f ? `${FIELD_LABELS[f]} ← column ${i + 1}` : "")).filter(Boolean);
    const hasCompany = review.mapping.includes("company");
    $("ir-summary").textContent =
      `${rows.length} row${rows.length === 1 ? "" : "s"} to import` +
      (rows.length > PREVIEW_ROWS ? ` (first ${PREVIEW_ROWS} shown)` : "") +
      `. ${mapped.length ? mapped.join(" · ") : "No columns mapped yet."}`;
    $("ir-error").textContent = hasCompany ? "" : "Choose which column holds the company / business name.";
    $("ir-import").disabled = !hasCompany || !rows.length;
    $("ir-import").textContent = `Import ${rows.length} row${rows.length === 1 ? "" : "s"}`;
  }

  $("ir-sheet").addEventListener("change", (e) => {
    useSheet(Number(e.target.value));
    renderReview();
  });
  $("ir-skip").addEventListener("input", (e) => {
    const sheet = review.sheets[review.sheetIdx];
    review.skip = Math.min(Math.max(0, Math.floor(Number(e.target.value) || 0)), sheet.rows.length - 1);
    renderReview();
  });
  $("ir-header").addEventListener("change", (e) => {
    review.header = e.target.checked;
    if (review.header) {
      // Re-read the mapping from the header row's names where they're recognized.
      const m = mapHeaders(review.sheets[review.sheetIdx].rows[review.skip] || []);
      if (Object.keys(m).length) {
        review.mapping = review.mapping.map(() => "");
        for (const [f, idx] of Object.entries(m)) if (FIELD_LABELS[f]) review.mapping[idx] = f;
      }
    }
    renderReview();
  });
  $("ir-head").addEventListener("change", (e) => {
    const col = e.target.dataset.col;
    if (col === undefined) return;
    const field = e.target.value;
    // Each field maps to one column: picking it here clears it elsewhere.
    if (field) review.mapping = review.mapping.map((f) => (f === field ? "" : f));
    review.mapping[Number(col)] = field;
    renderReview();
  });
  $("ir-cancel").addEventListener("click", () => {
    review = null;
    $("import-review").hidden = true;
  });

  $("ir-import").addEventListener("click", () => {
    if (!review) return;
    const map = {};
    review.mapping.forEach((f, i) => { if (f) map[f] = i; });
    if (map.company === undefined) return;
    const sourceLabel = $("lead-source").value.trim() || review.fileName;
    importRows(reviewDataRows(), map, sourceLabel);
    review = null;
    $("import-review").hidden = true;
    $("lead-file").value = "";
    $("lead-source").value = "";
  });

  function importRows(rows, map, sourceLabel) {
    const dropOutOfTerritory = $("skip-out-of-territory").checked;
    const dropHeadcount = $("skip-headcount").checked;

    const byId = new Map(state.leads.map((l) => [l.id, l]));
    const byKey = new Map(state.leads.map((l) => [companyKey(l), l]));
    const report = { added: 0, merged: 0, purgedEmails: 0, noName: 0, territory: 0, headcount: 0, dupInFile: 0 };
    const now = new Date().toISOString();

    for (const r of rows) {
      const get = (f) => (map[f] === undefined ? "" : cleanValue(f, r[map[f]]));
      const lead = {
        company: get("company"),
        address: get("address"),
        city: get("city"),
        county: get("county"),
        state: normalizeState(get("state")),
        zip: get("zip"),
        industry: get("industry"),
        employees: parseEmployees(get("employees")),
        website: get("website"),
        email: get("email").toLowerCase(),
        phone: get("phone"),
        contactName: get("contactName") || [get("firstName"), get("lastName")].filter(Boolean).join(" "),
        contactTitle: get("contactTitle"),
        emailStatus: normalizeEmailStatus(get("emailStatus")),
        source: get("source") || sourceLabel,
        stage: get("stage").toLowerCase(),
        notes: get("notes"),
      };
      splitAddress(lead);
      if (!lead.company) { report.noName++; continue; }
      if (lead.email && isConsumerEmail(lead.email)) {
        lead.email = "";
        lead.emailStatus = "";
        report.purgedEmails++;
      }

      const existing = (get("id") && byId.get(get("id"))) || byKey.get(companyKey(lead));
      if (existing) {
        // Waterfall re-import: fill gaps, and take newer enrichment/verification values.
        let changed = false;
        if (lead.email && lead.email !== existing.email && !lead.emailStatus) lead.emailStatus = "unverified";
        for (const [k, v] of Object.entries(lead)) {
          if (v === "" || k === "source" || k === "stage") continue;
          const overwrite = ["emailStatus", "employees", "contactName", "contactTitle", "email"].includes(k);
          if (existing[k] === undefined || existing[k] === "" || (overwrite && existing[k] !== v)) {
            existing[k] = v;
            changed = true;
          }
        }
        if (changed) {
          if (existing.stage === "new" && (lead.contactName || lead.contactTitle)) existing.stage = "enriched";
          if (["new", "enriched"].includes(existing.stage) && existing.emailStatus === "valid") existing.stage = "verified";
          existing.updated = now;
          existing.score = fitScore(existing);
          report.merged++;
        } else {
          report.dupInFile++;
        }
        continue;
      }

      normalizeLead(lead);
      if (dropOutOfTerritory && lead.region === "other") { report.territory++; continue; }
      if (dropHeadcount && sizeBand(lead) === "out") { report.headcount++; continue; }
      lead.id = newId();
      lead.created = lead.updated = now;
      state.leads.push(lead);
      byId.set(lead.id, lead);
      byKey.set(companyKey(lead), lead);
      report.added++;
    }

    save();
    renderAll();
    const lines = [
      `<strong>${report.added}</strong> new leads added, <strong>${report.merged}</strong> existing leads updated.`,
    ];
    if (report.purgedEmails) lines.push(`${report.purgedEmails} consumer email addresses purged (company kept).`);
    if (report.dupInFile) lines.push(`${report.dupInFile} duplicates skipped (no new info).`);
    if (report.territory) lines.push(`${report.territory} rows outside the four target regions dropped.`);
    if (report.headcount) lines.push(`${report.headcount} rows outside 20–500 employees dropped.`);
    if (report.noName) lines.push(`${report.noName} rows without a company name skipped.`);
    $("import-report").innerHTML = lines.map((l) => `<p>${l}</p>`).join("");
    $("import-report").hidden = false;
  }

  // --- Pipeline table ---------------------------------------------------------

  function fillSelect(select, options, keepFirst) {
    const first = keepFirst ? select.options[0] : null;
    select.replaceChildren(...(first ? [first] : []));
    for (const [value, label] of Object.entries(options)) {
      select.append(new Option(label, value));
    }
  }

  const segmentLabels = Object.fromEntries(Object.entries(SEGMENTS).map(([k, v]) => [k, v.label]));
  fillSelect($("f-region"), REGIONS, true);
  fillSelect($("f-segment"), segmentLabels, true);
  fillSelect($("f-stage"), STAGES, true);

  function filteredLeads() {
    const q = $("f-search").value.trim().toLowerCase();
    const region = $("f-region").value;
    const segment = $("f-segment").value;
    const stage = $("f-stage").value;
    const size = $("f-size").value;
    const sort = $("f-sort").value;
    const list = state.leads.filter((l) =>
      (!region || l.region === region) &&
      (!segment || l.segment === segment) &&
      (!stage || l.stage === stage) &&
      (!size || sizeBand(l) === size) &&
      (!q || [l.company, l.city, l.county, l.contactName, l.contactTitle, l.industry, l.email]
        .some((v) => (v || "").toLowerCase().includes(q)))
    );
    const cmp = {
      score: (a, b) => b.score - a.score || a.company.localeCompare(b.company),
      company: (a, b) => a.company.localeCompare(b.company),
      updated: (a, b) => (b.updated || "").localeCompare(a.updated || ""),
    }[sort];
    return list.sort(cmp);
  }

  const MAX_ROWS = 500;

  function renderTable() {
    const list = filteredLeads();
    const tbody = $("lead-rows");
    tbody.replaceChildren();
    for (const l of list.slice(0, MAX_ROWS)) {
      const tr = document.createElement("tr");
      tr.tabIndex = 0;
      tr.dataset.id = l.id;
      if (l.id === openId) tr.className = "selected";
      const cells = [
        { text: String(l.score), cls: `score s${l.score >= 70 ? "hi" : l.score >= 45 ? "mid" : "lo"}` },
        { text: l.company, sub: [l.city, l.state].filter(Boolean).join(", ") },
        { text: REGIONS[l.region] || "" },
        { text: SEGMENTS[l.segment] ? SEGMENTS[l.segment].label : "" },
        { text: l.employees === "" || l.employees === undefined ? "—" : String(l.employees),
          cls: sizeBand(l) === "out" ? "warn" : "" },
        { text: l.contactName || "—", sub: l.contactTitle },
        { text: l.email || "—", sub: l.email ? l.emailStatus : "" },
        { text: STAGES[l.stage], cls: `stage st-${l.stage}` },
      ];
      for (const c of cells) {
        const td = document.createElement("td");
        const span = document.createElement("span");
        span.textContent = c.text;
        if (c.cls) span.className = c.cls;
        td.append(span);
        if (c.sub) {
          const sub = document.createElement("div");
          sub.className = "sub";
          sub.textContent = c.sub;
          td.append(sub);
        }
        tr.append(td);
      }
      tbody.append(tr);
    }
    const shown = Math.min(list.length, MAX_ROWS);
    $("lead-count").textContent = list.length > MAX_ROWS
      ? `Showing ${shown} of ${list.length} matching (${state.leads.length} total) — narrow the filters`
      : `${list.length} of ${state.leads.length} leads`;
    $("empty-leads").hidden = state.leads.length > 0;
  }

  function renderStageCounts() {
    const counts = Object.fromEntries(Object.keys(STAGES).map((s) => [s, 0]));
    for (const l of state.leads) counts[l.stage]++;
    const bar = $("stage-counts");
    bar.replaceChildren();
    for (const [key, label] of Object.entries(STAGES)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `stage-pill st-${key}` + ($("f-stage").value === key ? " active" : "");
      b.innerHTML = `<strong></strong><span></span>`;
      b.querySelector("strong").textContent = counts[key];
      b.querySelector("span").textContent = label;
      b.addEventListener("click", () => {
        $("f-stage").value = $("f-stage").value === key ? "" : key;
        renderAll();
      });
      bar.append(b);
    }
  }

  function renderPlaybook() {
    const boxes = document.querySelectorAll("#playbook input[data-step]");
    let done = 0;
    boxes.forEach((b) => {
      b.checked = !!state.playbook[b.dataset.step];
      if (b.checked) done++;
    });
    $("playbook-progress").textContent = `${done}/${boxes.length} steps done`;
  }

  function renderAll() {
    renderStageCounts();
    renderTable();
    renderPlaybook();
  }

  document.querySelectorAll("#playbook input[data-step]").forEach((b) =>
    b.addEventListener("change", () => {
      state.playbook[b.dataset.step] = b.checked;
      save();
      renderPlaybook();
    })
  );

  for (const id of ["f-search", "f-region", "f-segment", "f-stage", "f-size", "f-sort"]) {
    $(id).addEventListener("input", renderAll);
  }

  $("lead-rows").addEventListener("click", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr) openLead(tr.dataset.id);
  });
  $("lead-rows").addEventListener("keydown", (e) => {
    const tr = e.target.closest("tr[data-id]");
    if (tr && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openLead(tr.dataset.id);
    }
  });

  const EXPORT_FIELDS = ["id", "company", "address", "city", "county", "state", "zip", "industry",
    "employees", "website", "email", "email_status", "phone", "contact_name", "contact_title",
    "region", "segment", "products", "target_titles", "triggers", "fit_score", "stage", "source", "notes"];

  $("export-filtered").addEventListener("click", () => {
    const list = filteredLeads();
    if (!list.length) return;
    const rows = list.map((l) => {
      const titles = (l.products || []).flatMap((p) => PRODUCTS[p].titles);
      return [
        l.id, l.company, l.address, l.city, l.county, l.state, l.zip, l.industry, l.employees,
        l.website, l.email, l.emailStatus, l.phone, l.contactName, l.contactTitle,
        REGIONS[l.region], SEGMENTS[l.segment].label,
        (l.products || []).map((p) => PRODUCTS[p].label).join("; "),
        [...new Set(titles)].join("; "),
        Object.keys(l.triggers || {}).filter((k) => l.triggers[k]).map((k) => TRIGGERS[k]).join("; "),
        l.score, STAGES[l.stage], l.source, l.notes,
      ];
    });
    hub.downloadCsv(`prospects-${hub.today()}.csv`, EXPORT_FIELDS, rows);
  });

  $("delete-filtered").addEventListener("click", () => {
    const list = filteredLeads();
    if (!list.length) return;
    if (!confirm(`Permanently delete the ${list.length} leads currently shown? Export first if you want a backup.`)) return;
    const ids = new Set(list.map((l) => l.id));
    state.leads = state.leads.filter((l) => !ids.has(l.id));
    if (ids.has(openId)) closeLead();
    save();
    renderAll();
  });

  $("add-lead").addEventListener("click", () => {
    const now = new Date().toISOString();
    const lead = normalizeLead({ id: newId(), company: "New lead", source: "Manual", created: now, updated: now });
    state.leads.push(lead);
    save();
    renderAll();
    openLead(lead.id);
    $("lead-form").elements.company.select();
  });

  // --- Lead detail ----------------------------------------------------------

  const form = $("lead-form");
  fillSelect(form.elements.region, REGIONS);
  fillSelect(form.elements.segment, segmentLabels);
  fillSelect(form.elements.stage, STAGES);

  function checkboxGroup(container, options, name) {
    container.replaceChildren();
    for (const [key, label] of Object.entries(options)) {
      const lab = document.createElement("label");
      lab.className = "check";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.name = name;
      box.value = key;
      lab.append(box, " " + (typeof label === "string" ? label : label.label));
      container.append(lab);
    }
  }
  checkboxGroup($("d-products"), PRODUCTS, "products");
  checkboxGroup($("d-triggers"), TRIGGERS, "triggers");

  const TEXT_FIELDS = ["company", "website", "address", "city", "county", "state", "zip", "industry",
    "employees", "phone", "region", "segment", "contactName", "contactTitle", "email", "emailStatus",
    "stage", "source", "notes"];

  function readForm() {
    const draft = {};
    for (const f of TEXT_FIELDS) draft[f] = form.elements[f].value.trim();
    draft.state = draft.state.toUpperCase();
    draft.email = draft.email.toLowerCase();
    draft.employees = draft.employees === "" ? "" : Number(draft.employees);
    draft.products = [...form.querySelectorAll("input[name=products]:checked")].map((b) => b.value);
    draft.triggers = Object.fromEntries(
      [...form.querySelectorAll("input[name=triggers]")].map((b) => [b.value, b.checked])
    );
    return draft;
  }

  function openLead(id) {
    const lead = state.leads.find((l) => l.id === id);
    if (!lead) return;
    openId = id;
    for (const f of TEXT_FIELDS) form.elements[f].value = lead[f] ?? "";
    form.querySelectorAll("input[name=products]").forEach((b) => (b.checked = (lead.products || []).includes(b.value)));
    form.querySelectorAll("input[name=triggers]").forEach((b) => (b.checked = !!(lead.triggers || {})[b.value]));
    $("d-title").textContent = lead.company;
    $("d-status").textContent = "";
    $("lead-detail").hidden = false;
    refreshDetailHints();
    renderTable();
  }

  function closeLead() {
    openId = null;
    $("lead-detail").hidden = true;
    renderTable();
  }

  function warningsFor(draft) {
    const w = [];
    if (draft.email && isConsumerEmail(draft.email)) {
      w.push("Consumer email domain — this can't be saved. Use a business address (info@, sales@, or the decision-maker's work email).");
    }
    if (["contacted", "qualified"].includes(draft.stage) && draft.email && draft.emailStatus !== "valid") {
      w.push("Email isn't verified as valid. Run it through ZeroBounce/NeverBounce before sending to protect domain health.");
    }
    if (draft.emailStatus === "invalid" && draft.stage === "contacted") {
      w.push("This address was verified invalid — don't send to it.");
    }
    if (sizeBand(draft) === "out") {
      w.push("Headcount is outside 20–500: smaller firms rarely buy structured programs; larger ones often have national contracts locked in.");
    }
    if (draft.region === "other") w.push("Outside the four target regions.");
    return w;
  }

  function draftEmail(d) {
    const first = (d.contactName || "").split(/\s+/)[0];
    // Lead with the product line the contact's title owns, and keep the pitch to two lines.
    const title = (d.contactTitle || "").toLowerCase();
    const owns = (p) => PRODUCTS[p].titles.some((t) =>
      t.toLowerCase().split(/[\s/()]+/).some((w) => w.length > 4 && title.includes(w)));
    const products = d.products.length ? [...d.products] : ["janitorial"];
    products.sort((a, b) => owns(b) - owns(a));
    const pitches = products.slice(0, 2).map((p) => PRODUCTS[p].pitch);
    const pitchText = pitches.join(" and ");
    const place = {
      philadelphia: d.city && d.city.toLowerCase() !== "philadelphia" ? `${d.city} and the Philadelphia area` : "Philadelphia",
      lehigh: "the Lehigh Valley",
      lancaster: "Lancaster County",
      nj: d.city ? `${d.city}, NJ` : "South Jersey",
      other: d.city || "your area",
    }[d.region] || "your area";

    let hook;
    if (d.triggers.newOffice) hook = `Congrats on the new location — I saw ${d.company} is expanding its footprint in ${place}.`;
    else if (d.triggers.relocation) hook = `I saw ${d.company}'s headquarters move in the local business news — moves like that are usually when workstation, facilities and team apparel decisions all land at once.`;
    else if (d.triggers.facilitiesHire) hook = `I noticed ${d.company} is hiring on the facilities/office side in ${place}.`;
    else if (d.triggers.uniformedTeam) hook = `Your on-site team in ${place} is the face of ${d.company} every day.`;
    else hook = `I work with ${(SEGMENTS[d.segment] || SEGMENTS.other).audience} across ${place}.`;

    const subject = d.triggers.newOffice || d.triggers.relocation
      ? `${d.company}'s new space in ${place}`
      : `${pitches[0][0].toUpperCase() + pitches[0].slice(1)} costs for ${d.company}`;

    return [
      `Subject: ${subject}`,
      "",
      `Hi ${first || "there"},`,
      "",
      hook,
      "",
      `Office Basics helps local teams lower their ${pitchText} costs. We normally start with a free good/better/best cost comparison against what you buy today — often the savings come from switching formats rather than just price.`,
      "",
      `Would a 15-minute call next week make sense?`,
      "",
      "Best,",
      "[Your name] · Office Basics · [Business mailing address]",
      "",
      `If you're not the person handling ${pitchText} at ${d.company}, just let me know — or reply "unsubscribe" and I won't contact you again.`,
    ].join("\n");
  }

  function refreshDetailHints() {
    const d = readForm();
    const titles = [...new Set(d.products.flatMap((p) => PRODUCTS[p].titles))];
    $("d-titles").textContent = titles.length ? `Target titles: ${titles.join(" · ")}` : "Select at least one product line.";
    const w = warningsFor(d);
    $("d-warning").hidden = !w.length;
    $("d-warning").textContent = w.join(" ");
    $("d-draft").value = draftEmail(d);
  }
  form.addEventListener("input", refreshDetailHints);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const lead = state.leads.find((l) => l.id === openId);
    if (!lead) return;
    const d = readForm();
    if (d.email && isConsumerEmail(d.email)) {
      refreshDetailHints();
      form.elements.email.focus();
      return;
    }
    Object.assign(lead, d, { updated: new Date().toISOString() });
    lead.score = fitScore(lead);
    save();
    $("d-title").textContent = lead.company;
    $("d-status").textContent = `Saved. Fit score ${lead.score}.`;
    renderAll();
  });

  $("d-close").addEventListener("click", closeLead);
  $("d-delete").addEventListener("click", () => {
    const lead = state.leads.find((l) => l.id === openId);
    if (!lead || !confirm(`Delete ${lead.company}?`)) return;
    state.leads = state.leads.filter((l) => l.id !== openId);
    save();
    closeLead();
    renderAll();
  });

  $("d-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("d-draft").value);
      $("d-status").textContent = "Draft copied.";
    } catch (_) {
      $("d-draft").select();
    }
  });

  // --- Handoff to Cost Comparison --------------------------------------------

  $("d-handoff").addEventListener("click", () => {
    const lead = state.leads.find((l) => l.id === openId);
    if (!lead) return;
    const d = readForm();
    if (d.email && isConsumerEmail(d.email)) {
      refreshDetailHints();
      return;
    }
    Object.assign(lead, d);
    lead.score = fitScore(lead);
    if (["new", "enriched", "verified", "contacted"].includes(lead.stage)) {
      lead.stage = "qualified";
      lead.updated = new Date().toISOString();
      form.elements.stage.value = "qualified";
    }
    hub.deal.set("lead", lead.id); // saves
    closeLead();
    window.showTab("compare");
    window.scrollTo({ top: 0 });
  });

  $("d-quote").addEventListener("click", () => {
    const lead = state.leads.find((l) => l.id === openId);
    if (!lead) return;
    const d = readForm();
    if (!(d.email && isConsumerEmail(d.email))) {
      Object.assign(lead, d);
      lead.score = fitScore(lead);
    }
    if (["new", "enriched", "verified", "contacted"].includes(lead.stage)) lead.stage = "qualified";
    closeLead();
    hub.quotes.newForLead(lead.id); // also makes this lead the current deal
  });

  // --- Reference table --------------------------------------------------------

  for (const p of Object.values(PRODUCTS)) {
    const tr = document.createElement("tr");
    for (const text of [p.label, p.titles.join(" · "), p.why]) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.append(td);
    }
    $("title-map").append(tr);
  }

  // --- Shared with the other tabs ---------------------------------------------

  Object.assign(hub.ref, { REGIONS, SEGMENTS, PRODUCTS, STAGES, regionFor });
  // CSV in the browser, Excel/PDF through the backend; used by the item catalog too.
  hub.readTableFile = readLeadFile;
  hub.openLead = (id) => {
    window.showTab("prospecting");
    openLead(id);
  };

  // Quotes/accounts can move a lead's stage; keep the table and open form in sync.
  hub.on(() => {
    renderAll();
    const lead = openId && state.leads.find((l) => l.id === openId);
    if (lead) form.elements.stage.value = lead.stage;
    else if (openId) closeLead();
  });

  state.leads.forEach((l) => (l.score = fitScore(l)));
  renderAll();
})();
