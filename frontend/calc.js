// Money, pricing and date rules shared by every tab. Pure functions only (no DOM,
// no storage) so the same file runs in the browser and under `node --test`.
//
// Amounts are rounded to whole cents where a customer or an invoice would see
// them, and sums are done on integer cents, so totals always add up to what is
// printed. The sell-price rule is Sell = Cost ÷ (1 − Margin): $60 at a 25%
// margin is $80 (a 25% *markup* would be $75). The Python twin of these rules is
// pricing.py; tests/fixtures/calc_cases.json is run against both.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SalesCalc = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  const num = (v) => (v !== "" && v !== null && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : 0);
  const hasValue = (v) => v !== "" && v !== undefined && v !== null;

  // Dollars -> integer cents, halves rounded away from zero. The tiny nudge undoes
  // binary noise (1.005 is stored as 1.00499999999999989…).
  const toCents = (dollars) => {
    const n = num(dollars);
    return Math.sign(n) * Math.round(Math.abs(n) * 100 + 1e-7);
  };
  const fromCents = (cents) => cents / 100;
  const round2 = (dollars) => fromCents(toCents(dollars));

  // --- Pricing ---------------------------------------------------------------

  // A usable margin is at least 0% and below 100% (at 100% the price is infinite).
  const validMargin = (m) => hasValue(m) && Number.isFinite(Number(m)) && Number(m) >= 0 && Number(m) < 100;
  const validCost = (c) => hasValue(c) && Number.isFinite(Number(c)) && Number(c) >= 0;

  // Sell price for a cost and target margin %, rounded UP to the cent so the price
  // never lands below the margin asked for. Returns null (never a made-up price)
  // when the cost or margin can't be used. Done in exact integer arithmetic
  // (BigInt on millionths): in binary floats 60 / 0.75 is 80.00000000000001, which
  // would round up to $80.01, and the error grows as the margin nears 100%.
  const micro = (n) => BigInt(Number(n).toFixed(6).replace(".", ""));
  function priceFor(cost, marginPct) {
    if (!validCost(cost) || !validMargin(marginPct)) return null;
    const numerator = micro(cost) * 10000n; // cost in cents × (100 − margin) denominator scale
    const denominator = 100000000n - micro(marginPct); // (100 − margin%) in millionths
    const cents = (numerator + denominator - 1n) / denominator; // ceiling division
    return Number(cents) / 100;
  }

  const marginOf = (cost, sell) => (num(sell) > 0 ? ((num(sell) - num(cost)) / num(sell)) * 100 : null);
  const markupOf = (cost, sell) => (num(cost) > 0 && hasValue(sell) ? ((num(sell) - num(cost)) / num(cost)) * 100 : null);

  // Cost of one use, or null when the data can't support it (never a guess).
  function costPerUse(price, usesPerCase) {
    if (!hasValue(price) || !hasValue(usesPerCase)) return null;
    const p = Number(price), u = Number(usesPerCase);
    return Number.isFinite(p) && Number.isFinite(u) && p >= 0 && u > 0 ? p / u : null;
  }

  // --- Quotes ----------------------------------------------------------------

  const FREQS = {
    once: { label: "One-time", mult: 1, recurring: false },
    month: { label: "Monthly", mult: 12, recurring: true },
    quarter: { label: "Quarterly", mult: 4, recurring: true },
    year: { label: "Annually", mult: 1, recurring: true },
  };

  const discountFraction = (q) => Math.min(100, Math.max(0, num(q.discountPct))) / 100;

  // Margin of one line after the quote's discount (a fraction `disc` of list price
  // is kept: 0.9 for a 10% discount). null when there's no cost or no price.
  function lineMargin(l, disc) {
    const sell = num(l.unitPrice) * disc;
    return hasValue(l.cost) && sell > 0 ? ((sell - num(l.cost)) / sell) * 100 : null;
  }

  // Everything a quote shows or exports. Rounding rules (all in whole cents):
  //  line extended = qty × unit price;  line net = extended after the quote discount
  //  subtotal = Σ extended;  discount = subtotal − Σ net;  tax = rate × Σ taxable net
  //  order total = Σ net + tax + delivery
  // Margin is on line revenue after discount (tax and delivery excluded) and only
  // over lines that have a cost; lines without one are counted in missingCost.
  function quoteTotals(q) {
    const disc = discountFraction(q);
    let subtotal = 0, net = 0, taxableNet = 0, recurring = 0, oneTime = 0, savings = 0, currentSpend = 0;
    let costedRevenue = 0, costTotal = 0, annualProfit = 0, missingCost = 0;
    for (const l of q.lines || []) {
      const f = FREQS[l.freq] || FREQS.once;
      const ext = toCents(num(l.qty) * num(l.unitPrice));
      const lineNet = toCents(num(l.qty) * num(l.unitPrice) * (1 - disc));
      subtotal += ext;
      net += lineNet;
      if (l.taxable) taxableNet += lineNet;
      if (f.recurring) recurring += lineNet * f.mult;
      else oneTime += lineNet;
      if (hasValue(l.currentPrice)) {
        const current = toCents(num(l.qty) * num(l.currentPrice)) * f.mult;
        currentSpend += current;
        savings += current - lineNet * f.mult;
      }
      if (hasValue(l.cost)) {
        const cost = toCents(num(l.qty) * num(l.cost));
        costedRevenue += lineNet;
        costTotal += cost;
        annualProfit += (lineNet - cost) * f.mult;
      } else if (ext > 0) {
        missingCost++;
      }
    }
    const tax = q.taxExempt ? 0 : Math.round((taxableNet * num(q.taxRate)) / 100 + 1e-7);
    const delivery = toCents(q.delivery);
    const grossProfit = costedRevenue - costTotal;
    return {
      subtotal: fromCents(subtotal),
      discount: fromCents(subtotal - net),
      tax: fromCents(tax),
      orderTotal: fromCents(net + tax + delivery),
      recurring: fromCents(recurring),
      oneTime: fromCents(oneTime),
      firstYear: fromCents(recurring + oneTime),
      savings: fromCents(savings),
      currentSpend: fromCents(currentSpend),
      savingsPct: currentSpend > 0 ? (savings / currentSpend) * 100 : null,
      costedRevenue: fromCents(costedRevenue),
      costTotal: fromCents(costTotal),
      grossProfit: fromCents(grossProfit),
      annualProfit: fromCents(annualProfit),
      missingCost,
      marginPct: costedRevenue > 0 ? (grossProfit / costedRevenue) * 100 : null,
    };
  }

  // --- Orders / invoices -------------------------------------------------------

  // Units billed on an invoice line: what shipped; if shipped was left blank, what was ordered.
  const billedQty = (l) => (hasValue(l.shipped) ? num(l.shipped) : num(l.qty));
  const backordered = (l) => (hasValue(l.backordered) ? num(l.backordered) : Math.max(0, num(l.qty) - billedQty(l)));

  // Merchandise = Σ (billed qty × unit price), each line rounded to the cent like an
  // invoice. Tax and freight are shown on the invoice but are not spend. Margin uses
  // only lines that have a cost. accounts_store.order_spend mirrors this on the server.
  function orderTotals(o) {
    let merch = 0, costed = 0, cost = 0, boLines = 0, boUnits = 0;
    for (const l of o.lines || []) {
      const ext = toCents(billedQty(l) * num(l.unitPrice));
      merch += ext;
      if (hasValue(l.cost)) {
        costed += ext;
        cost += toCents(billedQty(l) * num(l.cost));
      }
      const bo = backordered(l);
      if (bo > 0) {
        boLines++;
        boUnits += bo;
      }
    }
    const total = merch + toCents(o.tax) + toCents(o.freight);
    return {
      merch: fromCents(merch),
      total: fromCents(total),
      costed: fromCents(costed),
      cost: fromCents(cost),
      boLines,
      boUnits,
      marginPct: costed > 0 ? ((costed - cost) / costed) * 100 : null,
    };
  }

  // --- Dates -------------------------------------------------------------------
  // "Today" is the rep's calendar day, not UTC: after 7–8 pm Eastern the UTC date is
  // already tomorrow, which used to mark proposals expired and follow-ups overdue a day early.

  const pad = (n) => String(n).padStart(2, "0");
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function addDays(isoDate, days) {
    const d = new Date(`${String(isoDate).slice(0, 10)}T12:00:00`);
    d.setDate(d.getDate() + Number(days || 0));
    return localDate(d);
  }

  // A stored timestamp (ISO, UTC) or plain date -> the local calendar date it falls on.
  function toLocalDate(value) {
    const s = String(value || "");
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? "" : localDate(d);
  }

  const isRealDate = (iso) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!m) return false;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  };

  // --- CSV ---------------------------------------------------------------------

  // Excel and Sheets run cells that begin with = + - @ (or a tab/CR) as formulas, so
  // text from imported files or prospects could execute when someone opens an export.
  // A leading apostrophe makes the cell plain text. Numbers and phone-style values (digits, spaces, + - ( ) .) are left alone.
  function csvCell(v) {
    let s = v === undefined || v === null ? "" : String(v);
    if (typeof v !== "number" && /^[=+\-@\t\r]/.test(s) && !/^[+-]?[\d\s().-]+$/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  return {
    num, hasValue, toCents, fromCents, round2, validMargin, validCost, priceFor, marginOf, markupOf, costPerUse,
    FREQS, discountFraction, lineMargin, quoteTotals, billedQty, backordered, orderTotals,
    localDate, addDays, toLocalDate, isRealDate, csvCell,
  };
});
