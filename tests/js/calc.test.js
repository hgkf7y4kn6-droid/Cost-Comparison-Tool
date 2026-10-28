// Run with: node --test tests/js
process.env.TZ = "America/New_York";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../../frontend/calc.js");

const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/calc_cases.json"), "utf8"));
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !== ${b}`);

test("sell price follows Cost ÷ (1 − margin), rounded up to the cent", () => {
  for (const c of cases.price_for_margin) assert.equal(C.priceFor(c.cost, c.margin), c.expect, JSON.stringify(c));
});

test("an unusable cost or margin gives null, never a made-up price", () => {
  for (const c of cases.price_for_margin_invalid) assert.equal(C.priceFor(c.cost, c.margin), null, JSON.stringify(c));
  assert.equal(C.priceFor("", 20), null);
});

test("margin and markup are different things", () => {
  near(C.marginOf(60, 80), 25);
  near(C.markupOf(60, 80), 33.3333333333, 1e-6);
  assert.equal(C.marginOf(5, 0), null);
  assert.equal(C.markupOf(0, 5), null);
  assert.equal(C.markupOf("", 5), null);
});

test("cost per use", () => {
  for (const c of cases.cost_per_use) near(C.costPerUse(c.price, c.uses), c.expect, 1e-6);
  for (const c of cases.cost_per_use_unsupported) assert.equal(C.costPerUse(c.price, c.uses), null, JSON.stringify(c));
});

test("order merchandise rounds each line to the cent and bills shipped quantity", () => {
  for (const c of cases.order_merchandise) assert.equal(C.orderTotals({ lines: c.lines }).merch, c.expect, c.note);
});

test("order totals: tax and freight are not merchandise; margin ignores uncosted lines; back orders counted", () => {
  const t = C.orderTotals({
    tax: 6.5, freight: 12,
    lines: [
      { qty: 10, shipped: 6, unitPrice: 10, cost: 7 },   // 4 on back order
      { qty: 2, shipped: 2, unitPrice: 50 },             // no cost
    ],
  });
  assert.equal(t.merch, 160);
  assert.equal(t.total, 178.5);
  assert.equal(t.costed, 60);
  assert.equal(t.cost, 42);
  near(t.marginPct, 30);
  assert.deepEqual([t.boLines, t.boUnits], [1, 4]);
  assert.equal(C.orderTotals({ lines: [{ qty: 1, unitPrice: 5 }] }).marginPct, null);
});

const quote = {
  discountPct: 10, taxRate: 6, taxExempt: false, delivery: 25,
  lines: [
    { qty: 10, unitPrice: 80, cost: 60, freq: "month", taxable: true, currentPrice: 90 },
    { qty: 1, unitPrice: 500, cost: 300, freq: "once", taxable: true },
    { qty: 2, unitPrice: 25, cost: "", freq: "once", taxable: false },
  ],
};

test("quote totals match the hand-worked example", () => {
  const t = C.quoteTotals(quote);
  assert.equal(t.subtotal, 1350);
  assert.equal(t.discount, 135);
  assert.equal(t.tax, 70.2);                 // 6% of the taxable 1,170.00 after discount
  assert.equal(t.orderTotal, 1310.2);        // 1,215 + 70.20 + 25 delivery
  assert.equal(t.recurring, 8640);
  assert.equal(t.oneTime, 495);
  assert.equal(t.firstYear, 9135);
  assert.equal(t.costedRevenue, 1170);
  assert.equal(t.grossProfit, 270);
  near(t.marginPct, 23.0769230769, 1e-6);
  assert.equal(t.annualProfit, 1590);        // (720−600)×12 + (450−300)
  assert.equal(t.missingCost, 1);            // the uncosted line is flagged, not treated as 100% margin
  assert.equal(t.currentSpend, 10800);
  assert.equal(t.savings, 2160);
  near(t.savingsPct, 20);
});

test("tax exemption, no lines, and blank values", () => {
  assert.equal(C.quoteTotals({ ...quote, taxExempt: true }).tax, 0);
  const empty = C.quoteTotals({ lines: [] });
  assert.equal(empty.orderTotal, 0);
  assert.equal(empty.marginPct, null);
  assert.equal(empty.savingsPct, null);
  const messy = C.quoteTotals({ discountPct: "abc", taxRate: "", delivery: "", lines: [{ qty: "x", unitPrice: "", taxable: true }] });
  assert.equal(messy.orderTotal, 0);
  assert.equal(C.quoteTotals({ discountPct: 250, lines: [{ qty: 1, unitPrice: 10 }] }).orderTotal, 0); // clamped to 100%
});

test("totals on the printed proposal always add up (no stray cents)", () => {
  const q = { discountPct: 7.5, taxRate: 6.625, delivery: 0, lines: Array.from({ length: 9 }, (_, i) => ({ qty: 3, unitPrice: 3.33 + i * 0.07, taxable: true, freq: "once" })) };
  const t = C.quoteTotals(q);
  const cents = (x) => Math.round(x * 100);
  assert.equal(cents(t.subtotal) - cents(t.discount) + cents(t.tax), cents(t.orderTotal));
});

test("line margin reflects the discount", () => {
  near(C.lineMargin({ unitPrice: 100, cost: 60 }, 1), 40);
  near(C.lineMargin({ unitPrice: 100, cost: 60 }, 0.8), 25);
  assert.equal(C.lineMargin({ unitPrice: 100, cost: "" }, 1), null);
  assert.equal(C.lineMargin({ unitPrice: 0, cost: 5 }, 1), null);
});

test("rounding is half-up on the decimal value, not the binary one", () => {
  assert.equal(C.round2(1.005), 1.01);
  assert.equal(C.round2(2.675), 2.68);
  assert.equal(C.round2(-1.005), -1.01);
  assert.equal(C.round2(0.1 + 0.2), 0.3);
});

test("'today' is the local calendar date, not UTC", () => {
  const lateEvening = new Date("2026-03-10T01:30:00Z"); // 9:30 pm on Mar 9 in New York
  assert.equal(C.localDate(lateEvening), "2026-03-09");
  assert.equal(C.toLocalDate("2026-03-10T01:30:00.000Z"), "2026-03-09");
  assert.equal(C.toLocalDate("2026-03-10"), "2026-03-10");
  assert.equal(C.toLocalDate("garbage"), "");
});

test("addDays handles month ends, year ends and the clocks changing", () => {
  assert.equal(C.addDays("2026-01-31", 30), "2026-03-02");
  assert.equal(C.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(C.addDays("2026-03-08", 1), "2026-03-09"); // DST starts
  assert.equal(C.addDays("2026-11-01", 1), "2026-11-02"); // DST ends
  assert.equal(C.addDays("2026-03-10T23:00:00Z", 0), "2026-03-10");
});

test("isRealDate rejects impossible dates", () => {
  assert.ok(C.isRealDate("2024-02-29"));
  for (const bad of ["2025-02-29", "2025-13-01", "2025-00-10", "2025-1-1", "", null]) assert.ok(!C.isRealDate(bad), String(bad));
});

test("CSV cells: formulas are defused, ordinary values are untouched", () => {
  assert.equal(C.csvCell("=1+1"), "'=1+1");
  assert.equal(C.csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(C.csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(C.csvCell("+cmd|' /C calc'!A0"), "'+cmd|' /C calc'!A0");
  assert.equal(C.csvCell("-2+3"), "'-2+3");
  assert.equal(C.csvCell("\tTAB"), "'\tTAB");
  assert.equal(C.csvCell(-5), "-5");
  assert.equal(C.csvCell("-5.25"), "-5.25");
  assert.equal(C.csvCell("+1 (215) 555-0100"), "+1 (215) 555-0100");
  assert.equal(C.csvCell("08540"), "08540");
  assert.equal(C.csvCell("Smith, Jane"), '"Smith, Jane"');
  assert.equal(C.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(C.csvCell(null), "");
  assert.equal(C.csvCell(undefined), "");
});
