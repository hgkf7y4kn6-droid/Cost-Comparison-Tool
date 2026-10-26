// Service-region map on the Prospecting tab (Google Maps JavaScript API).
//
// Pins:
// - customer accounts: a star-topped pin, green, darker the more they've
//   spent this year (YTD orders). Your own accounts (all accounts for a
//   manager) open in full on click; other reps' accounts show only name,
//   address, phone and YTD spend — that limited record is all the server
//   sends for them (see accounts_store.py).
// - prospects (your leads not yet won): a round pin, blue to purple as the
//   lead moves through the pipeline. Click to open the lead.
//
// Addresses without a map position are looked up with Google's geocoder a few
// at a time; positions are refreshed after 30 days, in line with Google's
// limits on keeping geocoded coordinates. "Add from Google Maps" searches
// Google for a business in the region and turns it into a lead.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;
  const state = hub.state;
  const { money } = hub;
  const KEY = (window.GOOGLE_MAPS_API_KEY || "").trim();
  const MAP_ID = (window.GOOGLE_MAPS_MAP_ID || "").trim();

  // Philadelphia + suburbs, South/Central NJ, Lehigh Valley, Lancaster County.
  const REGION_BOUNDS = { south: 39.55, west: -76.75, north: 40.85, east: -74.25 };
  const GEO_MAX_AGE_DAYS = 30;
  const GEO_PER_BATCH = 250;
  const GEO_DELAY_MS = 250;

  // YTD spend tiers for account pins, light to dark green.
  const SPEND_TIERS = [
    { min: 0, color: "#9ae6b4", label: "Under $5k" },
    { min: 5000, color: "#48bb78", label: "$5k–$25k" },
    { min: 25000, color: "#2f855a", label: "$25k–$100k" },
    { min: 100000, color: "#22543d", label: "$100k–$250k" },
    { min: 250000, color: "#123524", label: "$250k+" },
  ];
  const tierFor = (spend) => [...SPEND_TIERS].reverse().find((t) => (spend || 0) >= t.min) || SPEND_TIERS[0];

  const PROSPECT_COLORS = [
    { stages: ["new", "enriched", "verified"], color: "#63b3ed", label: "New / enriched / verified" },
    { stages: ["contacted", "qualified"], color: "#2b6cb0", label: "Contacted / qualified" },
    { stages: ["proposal"], color: "#6b46c1", label: "Proposal sent" },
  ];
  const prospectColor = (stage) => (PROSPECT_COLORS.find((p) => p.stages.includes(stage)) || PROSPECT_COLORS[0]).color;

  // --- Pin artwork (SVG) -------------------------------------------------------

  function starPoints(cx, cy, outer, inner) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? inner : outer;
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      pts.push(`${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`);
    }
    return pts.join(" ");
  }
  const STAR = starPoints(16, 14, 13.5, 6);

  const svgUrl = (svg) => `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
  const accountSvg = (color, mine) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44">` +
    `<path d="M11.5 23 L16 42 L20.5 23 Z" fill="${color}" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/>` +
    `<polygon points="${STAR}" fill="${color}" stroke="${mine ? "#1a202c" : "#ffffff"}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  const prospectSvg = (color) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="38" viewBox="0 0 26 38">` +
    `<path d="M13 37 C13 37 2 22.5 2 13 A11 11 0 0 1 24 13 C24 22.5 13 37 13 37 Z" fill="${color}" stroke="#ffffff" stroke-width="1.8"/>` +
    `<circle cx="13" cy="13" r="4.2" fill="#ffffff"/></svg>`;

  // --- What goes on the map ----------------------------------------------------

  const located = (r) => Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) && r.lat !== "" && r.lat !== null;
  const addressOf = (r) => [r.address, r.city, r.state, r.zip].filter((v) => v && String(v).trim()).join(", ");

  function pins() {
    const out = [];
    const show = {
      mine: $("map-show-accounts").checked,
      others: $("map-show-others").checked,
      prospects: $("map-show-prospects").checked,
    };
    const accountLeadIds = new Set(state.accounts.map((a) => a.leadId).filter(Boolean));
    if (show.mine) {
      for (const a of state.accounts) {
        if (a.status === "churned" || !located(a)) continue;
        const spend = hub.accounts.ytdSpend(a);
        out.push({ key: `a:${a.id}`, kind: "account", rec: a, spend, svg: accountSvg(tierFor(spend).color, true), w: 32, h: 44 });
      }
    }
    if (show.others) {
      for (const a of hub.sharedAccounts || []) {
        if (!located(a)) continue;
        out.push({ key: `s:${a.id}`, kind: "shared", rec: a, spend: a.ytdSpend, svg: accountSvg(tierFor(a.ytdSpend).color, false), w: 32, h: 44 });
      }
    }
    if (show.prospects) {
      for (const l of state.leads) {
        if (["won", "disqualified"].includes(l.stage) || accountLeadIds.has(l.id) || !located(l)) continue;
        out.push({ key: `l:${l.id}`, kind: "lead", rec: l, svg: prospectSvg(prospectColor(l.stage)), w: 26, h: 38 });
      }
    }
    return out;
  }

  // --- Map ---------------------------------------------------------------------

  let map = null;
  let info = null;
  let geocoder = null;
  let advanced = null; // AdvancedMarkerElement class when a Map ID is configured
  const markers = new Map(); // key -> { marker, sig }

  function loadGoogle() {
    return new Promise((resolve, reject) => {
      if (window.google && window.google.maps && window.google.maps.importLibrary) return resolve();
      window.__salesHubMapsReady = () => resolve();
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(KEY)}&v=weekly&loading=async&libraries=places,marker&callback=__salesHubMapsReady`;
      s.async = true;
      s.onerror = () => reject(new Error("Couldn't load Google Maps (check the API key and that this site's address is allowed for it)."));
      document.head.append(s);
    });
  }

  // Google calls this when the key is rejected (wrong key, API not enabled, referrer not allowed).
  window.gm_authFailure = () => {
    showSetup("Google rejected the Maps API key. Check that the key is correct, that the Maps JavaScript API and Places API (New) are enabled, and that this site's address is in the key's allowed websites.");
  };

  function showSetup(message) {
    $("map-setup").hidden = false;
    if (message) $("map-setup-msg").textContent = message;
    $("map-tools").hidden = true;
    $("region-map").hidden = true;
    $("map-legend").hidden = true;
  }

  async function start() {
    if (!KEY) {
      showSetup();
      renderStatus();
      return;
    }
    try {
      await loadGoogle();
      const { Map, InfoWindow } = await google.maps.importLibrary("maps");
      if (MAP_ID) ({ AdvancedMarkerElement: advanced } = await google.maps.importLibrary("marker"));
      map = new Map($("region-map"), {
        mapId: MAP_ID || undefined,
        center: { lat: 40.2, lng: -75.5 },
        zoom: 8,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: true,
      });
      map.fitBounds(REGION_BOUNDS);
      info = new InfoWindow();
      geocoder = new google.maps.Geocoder();
      renderLegend();
      render();
      await setUpPlaceSearch();
      geocodeMissing();
    } catch (err) {
      showSetup(err.message);
    }
  }

  function render() {
    if (!map) return renderStatus();
    const want = pins();
    const seen = new Set();
    for (const p of want) {
      seen.add(p.key);
      const sig = `${p.rec.lat},${p.rec.lng},${p.svg}`;
      const existing = markers.get(p.key);
      if (existing && existing.sig === sig) {
        existing.pin = p;
        continue;
      }
      if (existing) removeMarker(existing.marker);
      const marker = makeMarker(p);
      markers.set(p.key, { marker, sig, pin: p });
    }
    for (const [key, m] of markers) {
      if (!seen.has(key)) {
        removeMarker(m.marker);
        markers.delete(key);
      }
    }
    renderStatus(want);
  }

  function makeMarker(p) {
    const position = { lat: Number(p.rec.lat), lng: Number(p.rec.lng) };
    const title = p.rec.company || "";
    let marker;
    if (advanced) {
      const img = document.createElement("img");
      img.src = svgUrl(p.svg);
      img.width = p.w;
      img.height = p.h;
      img.alt = "";
      marker = new advanced({ map, position, title, content: img, zIndex: p.kind === "lead" ? 1 : 2 });
      marker.addListener("click", () => onPinClick(p.key));
    } else {
      marker = new google.maps.Marker({
        map,
        position,
        title,
        zIndex: p.kind === "lead" ? 1 : 2,
        icon: { url: svgUrl(p.svg), scaledSize: new google.maps.Size(p.w, p.h), anchor: new google.maps.Point(p.w / 2, p.h) },
      });
      marker.addListener("click", () => onPinClick(p.key));
    }
    return marker;
  }

  function removeMarker(marker) {
    if (advanced && marker instanceof advanced) marker.map = null;
    else marker.setMap(null);
  }

  function onPinClick(key) {
    const m = markers.get(key);
    if (!m) return;
    const { kind, rec } = m.pin;
    if (kind === "account") return hub.accounts.open(rec.id);
    if (kind === "lead") return hub.openLead(rec.id);
    // Someone else's account: only what the server shares.
    const box = document.createElement("div");
    box.className = "map-info";
    const name = document.createElement("strong");
    name.textContent = rec.company || "Account";
    const addr = document.createElement("div");
    addr.textContent = addressOf(rec) || "No address on file";
    box.append(name, addr);
    if (rec.phone) {
      const tel = document.createElement("a");
      tel.href = `tel:${String(rec.phone).replace(/[^\d+]/g, "")}`;
      tel.textContent = rec.phone;
      box.append(tel);
    }
    const spend = document.createElement("div");
    spend.textContent = `YTD spend: ${money(rec.ytdSpend)}`;
    const note = document.createElement("small");
    note.className = "muted";
    note.textContent = "Another rep's account — details are limited to its owner and managers.";
    box.append(spend, note);
    info.setContent(box);
    info.open({ map, anchor: m.marker });
  }

  function renderLegend() {
    const box = $("map-legend");
    box.replaceChildren();
    const add = (svg, label, w, h) => {
      const item = document.createElement("span");
      item.className = "legend-item";
      const img = document.createElement("img");
      img.src = svgUrl(svg);
      img.width = Math.round(w * 0.6);
      img.height = Math.round(h * 0.6);
      img.alt = "";
      item.append(img, document.createTextNode(label));
      box.append(item);
    };
    const title = (t) => {
      const s = document.createElement("strong");
      s.textContent = t;
      box.append(s);
    };
    title("Accounts (YTD spend)");
    for (const t of SPEND_TIERS) add(accountSvg(t.color, false), t.label, 32, 44);
    title("Prospects");
    for (const p of PROSPECT_COLORS) add(prospectSvg(p.color), p.label, 26, 38);
    const note = document.createElement("small");
    note.className = "muted";
    note.textContent = "Dark outline = your account (opens in full).";
    box.append(note);
  }

  function renderStatus(shown) {
    const records = [...state.accounts, ...state.leads.filter((l) => !["won", "disqualified"].includes(l.stage)), ...(hub.sharedAccounts || [])];
    const have = records.filter(located).length;
    const missing = records.filter((r) => !located(r) && addressOf(r) && !r.limited && r.geoFailed !== addressOf(r)).length;
    $("map-aside").textContent = `${have} of ${records.length} on the map`;
    const status = $("map-status");
    status.textContent = !KEY
      ? `${records.length} accounts and prospects are ready to map once the Google Maps key is set.`
      : `${shown ? shown.length : 0} pin${shown && shown.length === 1 ? "" : "s"} shown. ${missing ? `${missing} more with an address still to locate.` : "Everything with an address is located."}`;
    $("map-locate-more").hidden = !KEY || !missing || geoRunning;
  }

  // --- Geocoding -------------------------------------------------------------

  let geoRunning = false;

  function needsGeocode(r) {
    const addr = addressOf(r);
    if (!addr || r.limited || r.geoFailed === addr) return false;
    if (!located(r) || r.geoQuery !== addr) return true;
    const age = (Date.now() - new Date(r.geocodedAt || 0).getTime()) / 86400000;
    return age > GEO_MAX_AGE_DAYS;
  }

  async function geocodeMissing() {
    if (!geocoder || geoRunning) return;
    geoRunning = true;
    renderStatus();
    const queue = [...state.accounts, ...state.leads].filter(needsGeocode).slice(0, GEO_PER_BATCH);
    let pending = 0;
    for (const r of queue) {
      const addr = addressOf(r);
      try {
        const res = await geocoder.geocode({ address: addr, bounds: REGION_BOUNDS, componentRestrictions: { country: "US" } });
        const hit = res && res.results && res.results[0];
        if (hit) {
          const loc = hit.geometry.location;
          r.lat = typeof loc.lat === "function" ? loc.lat() : loc.lat;
          r.lng = typeof loc.lng === "function" ? loc.lng() : loc.lng;
          r.geoQuery = addr;
          r.geocodedAt = new Date().toISOString();
          delete r.geoFailed;
        } else {
          r.geoFailed = addr;
        }
      } catch (err) {
        if (/ZERO_RESULTS/.test(String(err && (err.code || err.message)))) r.geoFailed = addr;
        else break; // quota, network or key problem: stop and try again later
      }
      if (++pending >= 10) {
        pending = 0;
        hub.save();
      }
      await new Promise((ok) => setTimeout(ok, GEO_DELAY_MS));
    }
    geoRunning = false;
    hub.save();
  }

  // --- Add a lead from Google Maps -------------------------------------------

  let picked = null; // fields for the business picked in the search box

  async function setUpPlaceSearch() {
    const places = await google.maps.importLibrary("places");
    const el = new places.PlaceAutocompleteElement({ includedRegionCodes: ["us"], locationRestriction: REGION_BOUNDS });
    el.id = "map-place-search";
    el.setAttribute("placeholder", "Search Google Maps for a business…");
    $("map-place-slot").replaceChildren(el);
    const onPlace = async (place) => {
      if (!place) return;
      await place.fetchFields({
        fields: ["id", "displayName", "formattedAddress", "addressComponents", "location", "nationalPhoneNumber", "websiteURI", "primaryTypeDisplayName", "types"],
      });
      showPreview(fromPlace(place));
    };
    // Newer API versions fire gmp-select with a prediction; older ones gmp-placeselect with a place.
    el.addEventListener("gmp-select", (e) => onPlace(e.placePrediction && e.placePrediction.toPlace()));
    el.addEventListener("gmp-placeselect", (e) => onPlace(e.place));
  }

  function fromPlace(place) {
    const comp = (type, short) => {
      const c = (place.addressComponents || []).find((x) => (x.types || []).includes(type));
      return c ? (short ? c.shortText : c.longText) || "" : "";
    };
    const street = [comp("street_number"), comp("route")].filter(Boolean).join(" ");
    const website = (place.websiteURI || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, "");
    const loc = place.location;
    return {
      company: (place.displayName && (place.displayName.text || place.displayName)) || "",
      address: street,
      city: comp("locality") || comp("sublocality") || comp("postal_town") || comp("administrative_area_level_3"),
      county: comp("administrative_area_level_2").replace(/\s+County$/i, ""),
      state: comp("administrative_area_level_1", true),
      zip: comp("postal_code"),
      phone: place.nationalPhoneNumber || "",
      website,
      industry: (place.primaryTypeDisplayName && (place.primaryTypeDisplayName.text || place.primaryTypeDisplayName)) || (place.types || [])[0] || "",
      placeId: place.id || "",
      formatted: place.formattedAddress || "",
      lat: loc ? (typeof loc.lat === "function" ? loc.lat() : loc.lat) : "",
      lng: loc ? (typeof loc.lng === "function" ? loc.lng() : loc.lng) : "",
    };
  }

  function showPreview(f) {
    picked = f;
    const box = $("place-preview");
    box.hidden = false;
    $("pp-name").textContent = f.company;
    $("pp-address").textContent = f.formatted || addressOf(f);
    $("pp-phone").textContent = f.phone || "No phone listed";
    $("pp-web").textContent = f.website || "No website listed";
    $("pp-industry").textContent = f.industry || "";
    const region = hub.ref.regionFor(f);
    $("pp-region").textContent = region === "other" ? "Outside your four target regions" : hub.ref.REGIONS[region];
    $("pp-region").className = region === "other" ? "stage warn" : "stage";
    const dupLead = hub.findLead(f);
    const key = (r) => `${(r.company || "").toLowerCase().trim()}|${(r.zip || "").slice(0, 5)}`;
    const dupAcct = [...state.accounts, ...(hub.sharedAccounts || [])].find((a) => key(a) === key(f));
    const dup = $("pp-dup");
    dup.hidden = !(dupLead || dupAcct);
    dup.textContent = dupAcct ? "Already a customer account." : dupLead ? `Already in your leads (${hub.ref.STAGES[dupLead.stage]}).` : "";
    $("pp-open").hidden = !dupLead;
    $("pp-add").hidden = !!dupLead || !!dupAcct;
    if (map && f.lat !== "") {
      map.panTo({ lat: Number(f.lat), lng: Number(f.lng) });
      if (map.getZoom && map.getZoom() < 12) map.setZoom(13);
    }
  }

  $("pp-add").addEventListener("click", () => {
    if (!picked) return;
    const { formatted, ...fields } = picked;
    const lead = hub.addLead({
      ...fields,
      source: "Google Maps",
      geoQuery: addressOf(fields),
      geocodedAt: new Date().toISOString(),
    });
    $("place-preview").hidden = true;
    picked = null;
    hub.openLead(lead.id);
  });
  $("pp-open").addEventListener("click", () => {
    const lead = picked && hub.findLead(picked);
    if (lead) hub.openLead(lead.id);
  });
  $("pp-cancel").addEventListener("click", () => {
    $("place-preview").hidden = true;
    picked = null;
  });

  for (const id of ["map-show-accounts", "map-show-others", "map-show-prospects"]) $(id).addEventListener("change", render);
  $("map-locate-more").addEventListener("click", geocodeMissing);

  // Re-draw on any change, and locate records that gained (or changed) an address.
  let renderTimer = null;
  let geoTimer = null;
  hub.on(() => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 150);
    if (!geocoder || geoRunning) return;
    clearTimeout(geoTimer);
    geoTimer = setTimeout(() => {
      if ([...state.accounts, ...state.leads].some(needsGeocode)) geocodeMissing();
    }, 1000);
  });

  // Load Google only when the map is first needed (the Prospecting tab).
  let started = false;
  const maybeStart = () => {
    if (started || $("tab-prospecting").hidden || !hub.auth) return;
    started = true;
    start();
  };
  new MutationObserver(maybeStart).observe($("tab-prospecting"), { attributes: true, attributeFilter: ["hidden"] });
  window.addEventListener("saleshub:signedin", maybeStart);
  maybeStart();
  renderStatus();

  hub.map = { tierFor, SPEND_TIERS, refresh: render };
})();
