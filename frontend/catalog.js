// Item catalog for building proposals: what you can sell, its cost, and which
// major category it belongs to. Imported from a cost file (CSV/Excel) and kept
// in this browser under its own storage key so a large catalog doesn't slow
// the rest of the hub. Quote lines pull their cost from here.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const KEY = "ob.catalog.v1";

  // The proposal builder's major categories, in display order.
  const CATEGORIES = {
    janitorial: "Janitorial Supplies",
    breakroom: "Breakroom Supplies",
    office: "Office Supplies",
    printing: "Printing Solutions",
    promo: "Print and Promotional",
    furniture: "Furniture",
    other: "Other",
  };

  // Checked in this order, against the file's category first and then the
  // item name, so "toner" lands in Printing Solutions, not Office Supplies.
  const CATEGORY_RULES = [
    ["furniture", /\b(furniture|chairs?|desks?|tables?|seating|cabinets?|workstations?|cubicles?|shelving|bookcases?|credenzas?|lockers?|ergonomic)\b/],
    ["printing", /\b(toner|ink|cartridges?|printers?|copiers?|mfp|managed print|mps|drums?|fusers?|imaging)\b/],
    ["promo", /\b(promo\w*|branded|logo|apparel|shirts?|polos?|hoodies?|jackets?|caps?|business cards?|letterhead|signage|banners?|brochures?|flyers?|print shop|marketing|giveaways?|drinkware|tote)\b/],
    ["breakroom", /\b(break ?room|coffee|k-cups?|tea|cups?|lids|plates?|utensils?|cutlery|forks?|spoons?|knives|napkins|snacks?|beverages?|water|sugar|creamers?|stirrers?|food ?service|kitchen)\b/],
    ["janitorial", /\b(janitorial|jan ?san|sanit\w*|clean\w*|can liners?|liners?|trash|towels?|tissue|toilet|soap|mops?|brooms?|gloves?|disinfect\w*|chemicals?|restroom|bleach|wipes?|floor care|degreaser)\b/],
    ["office", /\b(office|copy paper|paper|pens?|pencils?|markers?|highlighters?|binders?|folders?|stapl\w*|tape|notes?|notebooks?|pads?|envelopes?|labels?|clips?|filing|calculators?|scissors|desk accessories)\b/],
  ];

  function categorize(categoryText, name) {
    for (const text of [categoryText, name]) {
      const t = (text || "").toLowerCase();
      if (!t) continue;
      for (const [key, label] of Object.entries(CATEGORIES)) {
        if (t === label.toLowerCase() || t === key) return key;
      }
      for (const [key, re] of CATEGORY_RULES) if (re.test(t)) return key;
    }
    return "other";
  }

  // --- Storage -----------------------------------------------------------------

  let items = [];
  let bySku = new Map();
  const reindex = () => (bySku = new Map(items.filter((i) => i.sku).map((i) => [i.sku.toLowerCase(), i])));

  function loadItems() {
    items = [];
    const raw = hub.persistence.storage.get(KEY);
    try {
      const saved = JSON.parse(raw || "null");
      if (saved && Array.isArray(saved.items)) items = saved.items;
    } catch (_) {
      // Keep what was unreadable instead of letting the next import overwrite it.
      hub.persistence.setAside(raw, "item catalog unreadable");
      hub.persistence.notify("catalog-corrupt", "The saved item catalog couldn't be read, so it's empty. A copy was kept — open Backup to download it, or import your cost file again.", "warn");
    }
    reindex();
  }
  loadItems();
  // A different person signing in on this browser gets their own catalog (store.js moves it aside/back).
  hub.persistence.onUserSwitch(loadItems);

  function persist() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ items, updated: new Date().toISOString() }));
      return "";
    } catch (_) {
      return "This browser couldn't store a catalog this large. It's loaded for now but won't survive a reload — import just the categories you quote most.";
    }
  }

  // --- Search ------------------------------------------------------------------

  function search(cats, query, limit = 200) {
    const words = (query || "").toLowerCase().split(/\s+/).filter(Boolean);
    const want = cats && cats.size ? cats : null;
    const out = [];
    let total = 0;
    for (const it of items) {
      if (want && !want.has(it.cat)) continue;
      if (words.length) {
        const hay = `${it.name} ${it.sku} ${it.desc || ""} ${it.sub || ""}`.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      total++;
      if (out.length < limit) out.push(it);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { results: out, total };
  }

  function counts() {
    const c = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0]));
    for (const it of items) c[it.cat] = (c[it.cat] || 0) + 1;
    return c;
  }

  // --- Import ------------------------------------------------------------------

  const ALIASES = {
    sku: ["sku", "item", "itemnumber", "itemno", "item#", "partnumber", "partno", "productcode", "productid", "code", "stocknumber"],
    name: ["name", "itemname", "productname", "description", "itemdescription", "product", "title", "shortdescription"],
    desc: ["longdescription", "details", "fulldescription"],
    category: ["majorcategory", "category", "department", "productcategory", "class", "group", "categoryname"],
    sub: ["subcategory", "subclass"],
    cost: ["cost", "unitcost", "yourcost", "netcost", "dealercost", "ourcost", "cogs", "costeach", "costprice"],
    price: ["listprice", "price", "sellprice", "msrp", "retail", "list"],
    uom: ["uom", "unit", "unitofmeasure", "sellunit", "um"],
    pack: ["pack", "packsize", "packqty", "qtypercase", "packaging"],
  };
  const norm = (h) => String(h || "").toLowerCase().replace(/[^a-z0-9#]/g, "");

  function mapHeader(row) {
    const cells = row.map(norm);
    const map = {};
    const used = new Set();
    for (const [field, aliases] of Object.entries(ALIASES)) {
      for (const alias of aliases) {
        const i = cells.findIndex((c, idx) => c === alias && !used.has(idx));
        if (i >= 0) {
          map[field] = i;
          used.add(i);
          break;
        }
      }
    }
    return map;
  }

  const money = (v) => {
    const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
    return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
  };

  // rows: arrays of cells from any sheet. Finds the header row in the first 10.
  function importRows(rows, mode) {
    let header = -1, map = null;
    for (let i = 0; i < Math.min(10, rows.length); i++) {
      const m = mapHeader(rows[i]);
      if (m.name !== undefined && m.cost !== undefined) {
        header = i;
        map = m;
        break;
      }
    }
    if (!map) return { error: "Couldn't find item name and cost columns. The file needs a header row with columns like “Description” and “Cost” (see the template)." };
    const fresh = [];
    let skipped = 0;
    for (const r of rows.slice(header + 1)) {
      const get = (f) => (map[f] === undefined ? "" : String(r[map[f]] ?? "").trim());
      const name = get("name");
      const cost = money(get("cost"));
      if (!name || cost === null || cost < 0) {
        skipped++;
        continue;
      }
      const sku = get("sku");
      fresh.push({
        id: sku || `item-${fresh.length}-${name.slice(0, 20)}`,
        sku,
        name,
        desc: get("desc"),
        sub: get("category") || get("sub"),
        cat: categorize(get("category") || get("sub"), name),
        cost,
        price: money(get("price")),
        uom: get("uom") || "each",
        pack: get("pack"),
      });
    }
    if (!fresh.length) return { error: "No rows had both an item name and a cost." };
    let replaced = 0;
    if (mode === "replace") {
      items = fresh;
    } else {
      // Merge by SKU: a re-import updates costs for items you already have.
      const index = new Map(items.map((it, i) => [(it.sku || it.id).toLowerCase(), i]));
      for (const it of fresh) {
        const i = index.get((it.sku || it.id).toLowerCase());
        if (i !== undefined) {
          items[i] = it;
          replaced++;
        } else {
          index.set((it.sku || it.id).toLowerCase(), items.length);
          items.push(it);
        }
      }
    }
    reindex();
    const warning = persist();
    hub.save();
    return { added: fresh.length - replaced, replaced, skipped, warning };
  }

  // A small made-up catalog so the builder can be tried before importing a
  // real cost file. Names are generic and costs are placeholders, not pricing.
  const SAMPLE = [
    ["SAMPLE-JAN-001", "Hardwound roll towel, 8in x 800ft, white", "janitorial", 34.5, "case", "6 rolls"],
    ["SAMPLE-JAN-002", "Multifold towel, 1-ply, white", "janitorial", 22.75, "case", "4000 sheets"],
    ["SAMPLE-JAN-003", "Can liner 40-45 gal, 1.5 mil, black", "janitorial", 27.9, "case", "100 liners"],
    ["SAMPLE-JAN-004", "Foaming hand soap refill, 1000 mL", "janitorial", 41.2, "case", "6 refills"],
    ["SAMPLE-JAN-005", "Neutral floor cleaner concentrate, 1 gal", "janitorial", 18.4, "case", "4 gal"],
    ["SAMPLE-JAN-006", "Nitrile gloves, powder-free, large", "janitorial", 9.85, "box", "100 gloves"],
    ["SAMPLE-BRK-001", "Medium roast ground coffee, 2.5 oz packs", "breakroom", 38.0, "case", "42 packs"],
    ["SAMPLE-BRK-002", "Hot cups, 12 oz, paper", "breakroom", 29.6, "case", "1000 cups"],
    ["SAMPLE-BRK-003", "Bottled spring water, 16.9 oz", "breakroom", 5.4, "case", "24 bottles"],
    ["SAMPLE-BRK-004", "Plastic cutlery kit, fork/knife/spoon/napkin", "breakroom", 31.25, "case", "250 kits"],
    ["SAMPLE-BRK-005", "Powdered creamer packets", "breakroom", 7.15, "box", "1000 packets"],
    ["SAMPLE-BRK-006", "Paper plates, 9in, heavy duty", "breakroom", 24.8, "case", "500 plates"],
    ["SAMPLE-OFC-001", "Copy paper, 8.5x11, 20 lb, 92 bright", "office", 41.5, "case", "10 reams"],
    ["SAMPLE-OFC-002", "Ballpoint pens, medium, black", "office", 3.1, "box", "12 pens"],
    ["SAMPLE-OFC-003", "3-ring binder, 2in, white view", "office", 4.25, "each", ""],
    ["SAMPLE-OFC-004", "Self-stick notes, 3x3, yellow", "office", 6.9, "pack", "12 pads"],
    ["SAMPLE-OFC-005", "File folders, letter, 1/3 cut, manila", "office", 9.6, "box", "100 folders"],
    ["SAMPLE-OFC-006", "Shipping labels, 2x4, laser", "office", 18.3, "box", "1000 labels"],
    ["SAMPLE-PRT-001", "Black toner cartridge, high yield (laser)", "printing", 89.0, "each", ""],
    ["SAMPLE-PRT-002", "Color toner cartridge set, CMY", "printing", 214.0, "set", "3 cartridges"],
    ["SAMPLE-PRT-003", "Inkjet cartridge, black", "printing", 21.5, "each", ""],
    ["SAMPLE-PRT-004", "Imaging drum unit", "printing", 64.0, "each", ""],
    ["SAMPLE-PRT-005", "Managed print service, per device/month", "printing", 18.0, "device", ""],
    ["SAMPLE-PRT-006", "Multifunction printer, mid-volume (lease, monthly)", "printing", 95.0, "month", ""],
    ["SAMPLE-PRO-001", "Business cards, full color, 2-sided", "promo", 18.0, "box", "250 cards"],
    ["SAMPLE-PRO-002", "Branded polo shirt, embroidered logo", "promo", 16.75, "each", ""],
    ["SAMPLE-PRO-003", "Quarter-zip pullover, embroidered logo", "promo", 27.4, "each", ""],
    ["SAMPLE-PRO-004", "Logo tote bag, canvas", "promo", 4.9, "each", ""],
    ["SAMPLE-PRO-005", "Retractable banner stand, printed", "promo", 112.0, "each", ""],
    ["SAMPLE-PRO-006", "Branded drinkware tumbler, 20 oz", "promo", 8.2, "each", ""],
    ["SAMPLE-FUR-001", "Ergonomic mesh task chair", "furniture", 189.0, "each", ""],
    ["SAMPLE-FUR-002", "Height-adjustable desk, 60x30", "furniture", 412.0, "each", ""],
    ["SAMPLE-FUR-003", "Lateral file cabinet, 2-drawer", "furniture", 238.0, "each", ""],
    ["SAMPLE-FUR-004", "Conference table, 8 ft", "furniture", 640.0, "each", ""],
    ["SAMPLE-FUR-005", "Guest chair, stackable", "furniture", 72.0, "each", ""],
    ["SAMPLE-FUR-006", "Workstation panel system, per pod of 4", "furniture", 3150.0, "pod", ""],
  ];

  function loadSample() {
    const rows = [["SKU", "Description", "Category", "Cost", "UOM", "Pack"],
      ...SAMPLE.map(([sku, name, cat, cost, uom, pack]) => [sku, name, CATEGORIES[cat], cost, uom, pack])];
    return importRows(rows, "merge");
  }

  // --- Catalog card (Proposals tab) -------------------------------------------

  function render() {
    const c = counts();
    $("cat-summary").textContent = items.length
      ? `${items.length.toLocaleString()} item${items.length === 1 ? "" : "s"}`
      : "No items yet";
    const chips = $("cat-counts");
    chips.replaceChildren();
    for (const [key, label] of Object.entries(CATEGORIES)) {
      if (key === "other" && !c.other) continue;
      const span = document.createElement("span");
      span.className = "count-chip";
      span.textContent = `${label} · ${c[key]}`;
      chips.append(span);
    }
    $("cat-empty").hidden = items.length > 0;
    $("cat-clear").hidden = !items.length;
    const samples = items.filter((i) => i.sku.startsWith("SAMPLE-")).length;
    $("cat-sample-note").hidden = !samples;
  }

  function report(result) {
    const box = $("cat-report");
    box.hidden = false;
    box.className = result.error ? "status err" : "notice";
    box.textContent = result.error ||
      [`${result.added} item${result.added === 1 ? "" : "s"} added`,
        result.replaced ? `${result.replaced} updated` : "",
        result.skipped ? `${result.skipped} rows skipped (no name or cost)` : "",
        result.warning].filter(Boolean).join(" · ");
    render();
  }

  $("cat-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = $("cat-file").files[0];
    if (!file) return;
    const button = e.target.querySelector("button[type=submit]");
    button.disabled = true;
    try {
      const sheets = await hub.readTableFile(file);
      // Use the first sheet that has name and cost columns.
      let result = { error: "No sheet in this file had item name and cost columns." };
      for (const s of sheets) {
        const r = importRows(s.rows, $("cat-replace").checked ? "replace" : "merge");
        if (!r.error) {
          result = r;
          break;
        }
        result = r;
      }
      report(result);
      if (!result.error) $("cat-file").value = "";
    } catch (err) {
      report({ error: err.message });
    } finally {
      button.disabled = false;
    }
  });
  $("cat-sample").addEventListener("click", () => report(loadSample()));
  $("cat-clear").addEventListener("click", () => {
    if (!confirm(`Remove all ${items.length} catalog items from this browser? Quotes keep their lines.`)) return;
    items = [];
    reindex();
    persist();
    hub.save();
    $("cat-report").hidden = true;
    render();
  });

  hub.catalog = {
    CATEGORIES,
    categorize,
    search,
    counts,
    bySku: (sku) => (sku ? bySku.get(String(sku).toLowerCase()) || null : null),
    size: () => items.length,
    loadSample,
  };
  render();
})();
