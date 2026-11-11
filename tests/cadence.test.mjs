// Run with: node --test tests/cadence.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const cad = createRequire(import.meta.url)("../frontend/cadence.js");

const out = (date, id = date) => ({ id, date, type: "email", outbound: true });
const lead = (acts, extra = {}) => ({ stage: "contacted", activities: acts, ...extra });

test("business days skip weekends", () => {
  assert.equal(cad.addBusinessDays("2026-11-12", 3), "2026-11-17"); // Thu -> Tue
  assert.equal(cad.addBusinessDays("2026-11-13", 1), "2026-11-16"); // Fri -> Mon
});

test("first attempt: waits 3 business days, then is due", () => {
  const l = lead([out("2026-11-09")]); // Monday
  assert.deepEqual(cad.status(l, "2026-11-11").state, "waiting");
  const s = cad.status(l, "2026-11-12");
  assert.equal(s.state, "due");
  assert.equal(s.eligibleOn, "2026-11-12");
  assert.equal(s.followUpsLeft, 2);
});

test("the third unanswered attempt caps the lead", () => {
  const l = lead([out("2026-10-01"), out("2026-10-07"), out("2026-10-13")]);
  const s = cad.status(l, "2026-11-11");
  assert.equal(s.state, "capped");
  assert.equal(s.followUpsLeft, 0);
});

test("a reply or meeting restarts the count", () => {
  const l = lead([out("2026-10-01"), out("2026-10-07"), { id: "r", date: "2026-10-09", type: "email" }, out("2026-10-20")]);
  assert.equal(cad.attempts(l).length, 1);
  assert.equal(cad.status(l, "2026-11-11").state, "due");
  const l2 = lead([out("2026-10-01"), out("2026-10-07"), out("2026-10-13"), { id: "m", date: "2026-10-14", type: "meeting" }]);
  assert.equal(cad.status(l2, "2026-11-11").state, "none");
});

test("paused and warm leads are not subject to the cap", () => {
  assert.equal(cad.status(lead([out("2026-10-01")], { outreachPaused: true }), "2026-11-11").state, "paused");
  assert.equal(cad.status(lead([out("2026-10-01")], { stage: "qualified" }), "2026-11-11").state, "not-cold");
  assert.equal(cad.status({ stage: "new", activities: [] }, "2026-11-11").state, "not-cold");
});

test("only outreach marked as sent counts", () => {
  const l = lead([{ id: "a", date: "2026-10-01", type: "note", text: "thought about emailing" }]);
  assert.equal(cad.attempts(l).length, 0);
});
