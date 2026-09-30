const API_BASE = (window.API_BASE || "http://localhost:8000").replace(/\/$/, "");

const $ = (id) => document.getElementById(id);
const money = (n) =>
  "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

let comparisonId = "";

// Shared POST + error-message extraction used by every handler below.
async function postToApi(path, body, fallbackError) {
  let response;
  try {
    const isJson = !(body instanceof FormData);
    response = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      body: isJson ? JSON.stringify(body) : body,
      headers: isJson ? { "Content-Type": "application/json" } : undefined,
    });
  } catch (e) {
    throw new Error(`Connection failed: ${e.message}`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch (_) {
    // non-JSON error body
  }
  if (!response.ok) {
    const detail = data && data.detail;
    throw new Error(typeof detail === "string" ? detail : fallbackError);
  }
  return data;
}

// Disables the form's button while a request is in flight.
async function withBusy(form, fn) {
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await fn();
  } finally {
    button.disabled = false;
  }
}

function fileForm(inputId) {
  const fd = new FormData();
  fd.append("file", $(inputId).files[0]);
  return fd;
}

// --- 1. Catalog upload ---
$("catalog-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("catalog-error").textContent = "";
  withBusy(e.target, async () => {
    try {
      const data = await postToApi("/catalog/upload/", fileForm("catalog-file"), "Failed to load catalog");
      $("catalog-status").textContent =
        `Loaded ${data.loaded_items || 0} SKUs across ${(data.categories || []).length} categories.`;
    } catch (err) {
      $("catalog-status").textContent = "";
      $("catalog-error").textContent = err.message;
    }
  });
});

// --- 2. Competitor comparison ---
function renderTiers(tiers) {
  const container = $("tiers");
  container.replaceChildren();
  for (const tierName of ["good", "better", "best"]) {
    const item = tiers[tierName];
    if (!item) continue;
    const row = document.createElement("div");
    row.className = "tier";

    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = tierName.toUpperCase();

    const info = document.createElement("div");
    info.className = "info";
    const name = document.createElement("strong");
    name.textContent = item.name;
    const sku = document.createElement("div");
    sku.className = "sku";
    sku.textContent = `SKU: ${item.sku}`;
    info.append(name, sku);

    const price = document.createElement("span");
    price.className = "price";
    price.textContent = money(item.price);

    row.append(badge, info, price);
    container.append(row);
  }
}

$("compare-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("compare-error").textContent = "";
  withBusy(e.target, async () => {
    const fd = fileForm("compare-file");
    const uses = $("competitor-uses").value.trim();
    if (uses) fd.append("competitor_uses_per_case", uses);

    try {
      const data = await postToApi("/compare/download/", fd, "Comparison failed");
      const c = data.comparison;
      comparisonId = c.comparison_id || "";
      $("competitor-product").textContent = c.competitor_product || "";
      $("competitor-price").textContent = c.competitor_price ? money(c.competitor_price) : "Not detected";
      $("matched-category").textContent = c.matched_category || "";
      $("match-source").textContent =
        c.source === "learned" ? "Learned from a confirmed match" : "Algorithmic match";
      renderTiers(c.tiers || {});

      const lookup = c.manual_lookup;
      $("manual-lookup").hidden = !lookup;
      if (lookup) {
        $("manual-lookup-note").textContent = lookup.note;
        $("manual-lookup-link").href = lookup.portal_url;
      }

      $("download-link").href = `${API_BASE}${data.download_url}`;
      $("download-link").hidden = false;
      $("confirm-status").textContent = "";
      $("compare-results").hidden = false;
    } catch (err) {
      $("compare-error").textContent = err.message;
    }
  });
});

// --- Confirm / correct the recommendation ---
$("confirm-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!comparisonId) return;
  const status = $("confirm-status");
  status.textContent = "";
  status.className = "status";
  withBusy(e.target, async () => {
    const payload = { comparison_id: comparisonId };
    for (const [tier, inputId] of [["good", "good-sku"], ["better", "better-sku"], ["best", "best-sku"]]) {
      const value = $(inputId).value.trim();
      if (value) payload[`${tier}_sku`] = value;
    }
    try {
      await postToApi("/feedback/confirm/", payload, "Could not save feedback");
      status.textContent = "Saved — future similar products will use this match.";
      status.classList.add("ok");
    } catch (err) {
      status.textContent = err.message;
      status.classList.add("err");
    }
  });
});

// --- 3. Spend analysis ---
$("spend-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("spend-error").textContent = "";
  withBusy(e.target, async () => {
    const fd = fileForm("spend-file");
    fd.append("recommended_tier", $("spend-tier").value);
    try {
      const data = await postToApi("/analysis/spend/", fd, "Spend analysis failed");
      const s = data.summary;
      $("spend-current").textContent = money(s.total_current_spend);
      $("spend-recommended").textContent = money(s.total_recommended_spend);
      $("spend-savings").textContent = `${money(s.total_savings)} (${s.savings_pct.toFixed(1)}%)`;
      $("spend-rows").textContent = `${s.rows_analyzed} records analyzed, ${s.rows_unmatched} unmatched`;
      $("spend-manual-lookup").hidden = !s.manual_lookup_note;
      $("spend-manual-lookup-note").textContent = s.manual_lookup_note || "";
      $("spend-workbook-link").href = `${API_BASE}${data.workbook_url}`;
      $("spend-summary-link").href = `${API_BASE}${data.executive_summary_url}`;
      $("spend-results").hidden = false;
    } catch (err) {
      $("spend-error").textContent = err.message;
    }
  });
});
