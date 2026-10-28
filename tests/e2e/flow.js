// End-to-end flow against the real backend + real frontend (model libraries stubbed).
//   python tests/e2e/serve.py 8000 &     (the app only talks to same-origin on port 8000)
//   node tests/e2e/flow.js
// Uses only synthetic data and the test accounts defined in tests/conftest.py.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert/strict");

const BASE = process.env.BASE_URL || "http://127.0.0.1:8000";
const REP = ["rep@example.com", "correct horse battery staple"];
const REP2 = ["rep2@example.com", "correct horse battery staple"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "saleshub-e2e-"));
const write = (name, text) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, text);
  return p;
};

let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n     ${e.message.split("\n").join("\n     ")}`);
    process.exitCode = 1;
    throw e;
  }
};

async function newPage(browser, errors, opts = {}) {
  const ctx = opts.context || (await browser.newContext({ acceptDownloads: true, viewport: opts.viewport || { width: 1280, height: 900 } }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push("console: " + m.text());
  });
  page.on("dialog", (d) => d.accept()); // confirm() prompts
  await page.addInitScript(() => {
    window.print = () => { window.__printed = document.getElementById("proposal-print").innerHTML; };
  });
  return page;
}

async function signIn(page, [email, password]) {
  await page.goto(BASE + "/");
  await page.waitForSelector("#signin:not([hidden]), #auth-bar:not([hidden])");
  if (await page.isVisible("#signin")) {
    await page.fill("#signin-email", email);
    await page.fill("#signin-password", password);
    await page.click("#signin-form button[type=submit]");
  }
  await page.waitForSelector("#auth-bar:not([hidden])");
}

// Polls a (possibly async) browser-side predicate until it's truthy. Playwright's own
// waitForFunction does not await an async predicate, so this loops evaluate() instead.
const waitFor = async (pg, label, fn, arg, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await pg.evaluate(fn, arg).catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  const where = await pg.evaluate(() => ({ leads: window.SalesHub.state.leads.length, quotes: window.SalesHub.state.quotes.length, accounts: window.SalesHub.state.accounts.length, user: window.SalesHub.auth && window.SalesHub.auth.email, status: (document.querySelector("[data-sync-status]") || {}).textContent })).catch(() => ({}));
  throw new Error(`timed out waiting for: ${label} (${JSON.stringify(where)})`);
};
const stateOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("ob.prospecting.v1") || "{}"));
const tab = async (page, name) => { await page.click(`[data-tab=${name}]`); await page.waitForSelector(`#tab-${name}:not([hidden])`); };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const page = await newPage(browser, errors);

  try {
    await step("a wrong password is refused and nothing is stored", async () => {
      await page.goto(BASE + "/");
      await page.fill("#signin-email", REP[0]);
      await page.fill("#signin-password", "definitely-the-wrong-password");
      await page.click("#signin-form button[type=submit]");
      await page.waitForFunction(() => document.getElementById("signin-error").textContent.length > 0);
      assert.match(await page.textContent("#signin-error"), /incorrect/i);
      assert.equal(await page.evaluate(() => localStorage.getItem("ob.auth.v1")), null);
    });

    await step("signing in shows the app", async () => {
      await signIn(page, REP);
      assert.equal(await page.textContent("#auth-user"), REP[0]);
      assert.ok(await page.isVisible("#tab-today"));
    });

    await step("import a prospect list: review step, then import", async () => {
      await tab(page, "prospecting");
      const csv = [
        "company,address,city,county,state,zip,industry,employees,website,email,phone,contact_name,contact_title,source",
        "Acme Orthopedic LLC,1 Market St,Philadelphia,Philadelphia,PA,19103,Physician practice,85,acmeortho.example,info@acmeortho.example,215-555-0100,Jo Smith,Office Manager,test",
        "Acme Orthopedic LLC,1 Market St,Philadelphia,Philadelphia,PA,19103,Physician practice,85,acmeortho.example,info@acmeortho.example,215-555-0100,,,test",
        "Beta Logistics Inc,5 Industrial Blvd,Allentown,Lehigh,PA,18106,Warehousing,240,beta.example,ops@beta.example,610-555-0100,,,test",
        "Gamma Hedge Fund,1 Wall St,New York,New York,NY,10005,Finance,50,gamma.example,x@gmail.com,212-555-0100,,,test",
        '"=HYPERLINK(""http://evil.example"",""x"")",2 Main St,Camden,Camden,NJ,08002,Software,60,evil.example,,856-555-0100,,,test',
      ].join("\n");
      await page.setInputFiles("#lead-file", write("leads.csv", csv));
      await page.click("#lead-import-form button[type=submit]");
      await page.waitForSelector("#import-review:not([hidden])");
      assert.ok((await page.textContent("#ir-summary")).length > 0);
      await page.click("#ir-import");
      await page.waitForSelector("#import-report:not([hidden])");
      const report = await page.textContent("#import-report");
      assert.match(report, /3 new leads added/); // Acme (deduped), Beta, the formula-named one; Gamma is out of territory
      const st = await stateOf(page);
      const names = st.leads.map((l) => l.company);
      assert.ok(names.includes("Acme Orthopedic LLC") && names.includes("Beta Logistics Inc"));
      assert.equal(names.filter((n) => n.startsWith("Acme")).length, 1, "duplicate rows merge into one lead");
      assert.equal(st.leads.find((l) => l.company === "Acme Orthopedic LLC").contactName, "Jo Smith", "the merge keeps the useful contact");
    });

    await step("exported CSV neutralises formula-looking company names", async () => {
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#export-csv, #p-export, button:has-text('Export shown')")]);
      const text = fs.readFileSync(await dl.path(), "utf8");
      assert.ok(!/(^|\n|,)"?=HYPERLINK/.test(text), "formula must not start a cell");
      assert.match(text, /'=HYPERLINK/);
    });

    await step("lead -> quote: price from cost uses margin (not markup), proposal hides cost", async () => {
      const st = await stateOf(page);
      const lead = st.leads.find((l) => l.company === "Acme Orthopedic LLC");
      await page.evaluate((id) => window.SalesHub.deal.set("lead", id), lead.id);
      await page.evaluate((id) => { window.SalesHub.state.leads.find((l) => l.id === id).stage = "qualified"; window.SalesHub.save(); }, lead.id);
      await tab(page, "quotes");
      await page.click("#q-new");
      await page.waitForSelector("#quote-editor:not([hidden])");
      await page.evaluate(() => { window.SalesHub.state.profile = { repName: "Pat Rep" }; window.SalesHub.save(); });
      await page.click('[data-pick="new"]');
      await page.waitForSelector("#item-picker:not([hidden])");
      await page.click("#ip-custom");
      await page.fill("#ip-name", "Can liners 33gal");
      await page.fill("#ip-cost", "60");
      await page.fill("#ip-margin", "25");
      assert.equal(await page.inputValue("#ip-sell"), "80.00", "$60 at a 25% margin is $80, not $75");
      await page.fill("#ip-margin", "100");
      assert.match(await page.textContent("#ip-error"), /below 100%/);
      await page.fill("#ip-margin", "25");
      await page.fill("#ip-qty", "10");
      await page.click("#ip-save");
      await page.click("#qe-save");
      await page.waitForFunction(() => document.getElementById("qe-status").textContent.includes("Saved"));
      const q = (await stateOf(page)).quotes[0];
      assert.equal(q.lines[0].unitPrice, 80);
      assert.equal(q.lines[0].cost, 60);
      await page.click("#qe-print");
      const html = await page.evaluate(() => window.__printed);
      assert.match(html, /Can liners 33gal/);
      assert.match(html, /\$800\.00/);
      for (const secret of [/>\s*60(\.00)?\s*</, /\$60\.00/, /margin/i, /gross profit/i, /cost/i, /🔒/, /internal/i]) {
        assert.ok(!secret.test(html), `customer proposal must not contain ${secret}`);
      }
    });

    await step("mark sent, then won -> exactly one account, then no duplicate on repeat", async () => {
      await page.click("#qe-mark-sent");
      await page.waitForFunction(() => document.getElementById("qe-status").textContent.includes("Marked sent"));
      await page.click("#qe-mark-won");
      await page.waitForFunction(() => document.getElementById("qe-status").textContent.startsWith("Won"));
      let st = await stateOf(page);
      assert.equal(st.accounts.length, 1);
      assert.equal(st.leads.find((l) => l.company === "Acme Orthopedic LLC").stage, "won");
      await page.click("#qe-save");
      st = await stateOf(page);
      assert.equal(st.accounts.length, 1);
      assert.equal(st.accounts[0].status, "onboarding");

    });

    await step("orders: import is reviewed, a partial re-export is not applied silently, and import can be undone", async () => {
      if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: false });
      await page.keyboard.press("Escape"); // side panels close with Esc
      await tab(page, "accounts");
      const acctName = (await stateOf(page)).accounts[0].company;
      const year = new Date().getFullYear();
      const header = "Invoice,Invoice Date,Customer,SKU,Description,Qty Ordered,Qty Shipped,Unit Price,Unit Cost";
      const full = [header,
        `INV-1,${year}-03-05,${acctName},LNR-1,Can liners,10,10,80.00,60.00`,
        `INV-1,${year}-03-05,${acctName},TWL-1,Towels,4,2,40.00,25.00`].join("\n");
      await page.click("#orders-import-toggle");
      await page.setInputFiles("#orders-file", write("inv.csv", full));
      await page.click("#orders-import-form button[type=submit]");
      await page.waitForFunction(() => document.getElementById("orders-report").textContent.includes("Review before importing"));
      let st = await stateOf(page);
      assert.equal((st.accounts[0].orders || []).length, 0, "nothing is saved before confirming");
      await page.click("#orders-report button:has-text('Import')");
      st = await stateOf(page);
      assert.equal(st.accounts[0].orders.length, 1);
      assert.equal(st.accounts[0].orders[0].lines.length, 2);

      // the same file again: nothing to do
      await page.setInputFiles("#orders-file", write("inv.csv", full));
      await page.click("#orders-import-form button[type=submit]");
      await page.waitForFunction(() => document.getElementById("orders-report").textContent.includes("already up to date"));
      assert.match(await page.textContent("#orders-report"), /0 new orders, 0 existing/);
      await page.click("#orders-report button:has-text('Cancel')");

      // a partial export of the same invoice: flagged, unchecked, so Import leaves the invoice alone
      const partial = [header, `INV-1,${year}-03-05,${acctName},LNR-1,Can liners,10,10,80.00,60.00`].join("\n");
      await page.setInputFiles("#orders-file", write("inv2.csv", partial));
      await page.click("#orders-import-form button[type=submit]");
      await page.waitForFunction(() => document.getElementById("orders-report").textContent.includes("partial export"));
      assert.equal(await page.isChecked("#orders-report input[type=checkbox]"), false);
      await page.click("#orders-report button:has-text('Import')");
      st = await stateOf(page);
      assert.equal(st.accounts[0].orders[0].lines.length, 2, "the full invoice is untouched");

      // tick it, replace, undo
      await page.setInputFiles("#orders-file", write("inv2.csv", partial));
      await page.click("#orders-import-form button[type=submit]");
      await page.waitForFunction(() => document.getElementById("orders-report").textContent.includes("partial export"));
      await page.check("#orders-report input[type=checkbox]");
      await page.click("#orders-report button:has-text('Import')");
      st = await stateOf(page);
      assert.equal(st.accounts[0].orders[0].lines.length, 1);
      assert.equal(st.accounts[0].replacedOrders.length, 1, "the replaced version is kept on the account");
      await page.click("#orders-report button:has-text('Undo this import')");
      st = await stateOf(page);
      assert.equal(st.accounts[0].orders[0].lines.length, 2);

      // a row with an impossible date is reported, not dated "today"
      const bad = [header, `INV-9,13/45/${year},${acctName},LNR-1,Can liners,1,1,80.00,60.00`].join("\n");
      await page.setInputFiles("#orders-file", write("inv3.csv", bad));
      await page.click("#orders-import-form button[type=submit]");
      await page.waitForFunction(() => document.getElementById("orders-report").textContent.includes("left out"));
      assert.match(await page.textContent("#orders-report"), /isn't a real date/);
      await page.click("#orders-report button:has-text('Cancel')");
    });

    await step("YTD uses shipped quantity x price: 10x80 + 2x40 = $880.00", async () => {
      const text = await page.textContent("#a-kpis");
      assert.match(text, /\$880\.00/);
    });

    await step("backup downloads, validates, and restores without duplicating records", async () => {
      await page.click("#backup-open");
      const [dl] = await Promise.all([page.waitForEvent("download"), page.click("button:has-text('Download backup')")]);
      const file = await dl.path();
      const backup = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.equal(backup.app, "sales-hub-backup");
      assert.equal(backup.data.quotes.length, 1);
      const before = await stateOf(page);
      await page.setInputFiles("#backup-body input[type=file]", file);
      await page.click("button:has-text('Add records that are missing')");
      await page.waitForFunction(() => document.getElementById("backup-msg").textContent.includes("Added"));
      const after = await stateOf(page);
      assert.equal(after.quotes.length, before.quotes.length);
      assert.equal(after.leads.length, before.leads.length);
      // a bad file is rejected without changes
      await page.setInputFiles("#backup-body input[type=file]", write("junk.json", '{"app":"something-else"}'));
      await page.waitForFunction(() => document.getElementById("backup-body").textContent.includes("isn't a Sales Hub backup"));
      await page.setInputFiles("#backup-body input[type=file]", write("junk2.json", "not json at all"));
      await page.waitForFunction(() => document.getElementById("backup-body").textContent.includes("isn't valid JSON"));
      await page.click("#backup-close");
    });

    await step("corrupt local data is set aside, not overwritten, and the app still starts", async () => {
      // Edits reach the server shortly after they're made; wait for that so the next reload only loses the local copy.
      await waitFor(page, "account reaches the server", async () => (await (await window.SalesHub.api.fetch("/records/accounts/")).json()).records.length >= 1);
      await page.evaluate(() => localStorage.setItem("ob.prospecting.v1", '{"quotes":[{"id":"Qx"'));
      await page.reload();
      await page.waitForSelector("#auth-bar:not([hidden])");
      await page.waitForSelector("#storage-notice:not([hidden])");
      assert.match(await page.textContent("#storage-notice"), /couldn't be read/);
      const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("ob.prospecting.v1.corrupt.")).map((k) => localStorage.getItem(k)));
      assert.deepEqual(kept, ['{"quotes":[{"id":"Qx"']);
      // restore this person's data from the file we just exported earlier is covered above; put state back for the next steps
    });

    await step("a quota error is reported, not swallowed", async () => {
      await page.evaluate(() => {
        Storage.prototype.__set = Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) { if (k === "ob.prospecting.v1") throw new DOMException("full", "QuotaExceededError"); return this.__set(k, v); };
        window.SalesHub.save();
      });
      await page.waitForFunction(() => document.getElementById("storage-notice").textContent.includes("could not be saved"));
      await page.evaluate(() => { Storage.prototype.setItem = Storage.prototype.__set; window.SalesHub.save(); });
      await page.waitForFunction(() => !document.getElementById("storage-notice").textContent.includes("could not be saved"));
    });

    await step("another person on the same browser does not see this person's proposals", async () => {
      await page.evaluate(() => { window.SalesHub.state.quotes.push({ id: "Qsecret", number: "Q-1", company: "Secret Co", status: "draft", lines: [{ id: "l1", name: "x", qty: 1, unitPrice: 10, cost: 5 }] }); window.SalesHub.save(); });
      await page.click("#auth-signout");
      await page.waitForSelector("#signin:not([hidden])");
      await signIn(page, REP2);
      const st = await stateOf(page);
      assert.equal(st.quotes.length, 0, "rep2 starts with their own (empty) local data");
      assert.equal(st.localOwner, REP2[0]);
      await page.click("#auth-signout");
      await page.waitForSelector("#signin:not([hidden])");
      await signIn(page, REP);
      const back = await stateOf(page);
      assert.ok(back.quotes.some((q) => q.id === "Qsecret"), "rep's own data returns when they sign back in");
      assert.equal(back.localOwner, REP[0]);
    });

    await step("two people editing the same lead: the second save is refused, not silently overwriting", async () => {
      const serverLead = (pg, id) => pg.evaluate(async (leadId) => {
        const res = await window.SalesHub.api.fetch("/records/leads/");
        return (await res.json()).records.find((r) => r.id === leadId) || null;
      }, id);
      const a = page; // signed in as rep
      const lead = await a.evaluate(() => window.SalesHub.addLead({ company: "Delta Dental Group", city: "Philadelphia", state: "PA", zip: "19103", notes: "v1" }).id);
      await waitFor(a, "A's new lead reaches the server", async (id) => (await (await window.SalesHub.api.fetch("/records/leads/")).json()).records.some((r) => r.id === id), lead);

      const b = await newPage(browser, errors);
      await signIn(b, REP2);
      await waitFor(b, "B receives the lead", (id) => window.SalesHub.state.leads.some((l) => l.id === id), lead);
      const rev1 = await b.evaluate((id) => window.SalesHub.state.leads.find((l) => l.id === id).rev, lead);
      assert.equal(typeof rev1, "number");

      // A saves first.
      await a.evaluate((id) => { window.SalesHub.state.leads.find((l) => l.id === id).notes = "A-edit"; window.SalesHub.save(); }, lead);
      await waitFor(a, "A's edit reaches the server", async (id) => (await (await window.SalesHub.api.fetch("/records/leads/")).json()).records.find((r) => r.id === id).notes === "A-edit", lead);

      // B edits from the old version.
      await b.evaluate((id) => { window.SalesHub.state.leads.find((l) => l.id === id).notes = "B-edit"; window.SalesHub.save(); }, lead);
      await waitFor(b, "B's edit is refused and kept aside", () => window.SalesHub.sync.conflicts().length === 1);
      assert.equal((await serverLead(b, lead)).notes, "A-edit", "the server keeps the first save");
      await waitFor(b, "B now shows A's version", (id) => window.SalesHub.state.leads.find((l) => l.id === id).notes === "A-edit", lead);
      const kept = await b.evaluate(() => window.SalesHub.sync.conflicts()[0]);
      assert.equal(kept.record.notes, "B-edit", "the losing edit is preserved locally");
      assert.match(await b.textContent("[data-sync-status]"), /changed by someone else/);
      await b.context().close();
    });

    await step("proposals reach the server only when asked, follow the owner to a second device, and stay private", async () => {
      const serverQuotes = (pg) => pg.evaluate(async () => (await (await window.SalesHub.api.fetch("/records/quotes/")).json()).records.map((q) => q.id));
      assert.deepEqual(await serverQuotes(page), [], "nothing is uploaded until the person opts in");
      await page.evaluate(() => window.SalesHub.sync.enableQuotes());
      await waitFor(page, "proposals upload", async () => (await (await window.SalesHub.api.fetch("/records/quotes/")).json()).records.length >= 1);
      const ids = await serverQuotes(page);
      const device2 = await newPage(browser, errors);
      await signIn(device2, REP);
      await device2.evaluate(() => window.SalesHub.sync.enableQuotes());
      await waitFor(device2, "second device receives the proposals", (want) => want.every((id) => window.SalesHub.state.quotes.some((q) => q.id === id)), ids);
      await device2.context().close();
      const other = await newPage(browser, errors);
      await signIn(other, REP2);
      await other.evaluate(() => window.SalesHub.sync.enableQuotes());
      await other.waitForTimeout(800);
      assert.deepEqual(await other.evaluate(() => window.SalesHub.state.quotes.map((q) => q.id)), [], "another rep never receives them");
      await other.context().close();
    });

    await step("if the server comes back empty, local records are kept and uploaded again", async () => {
      const count = await page.evaluate(() => window.SalesHub.state.leads.length);
      assert.ok(count >= 3);
      // Simulate a server that lost its data: remove every lead from it (as their owner), then sync.
      await page.evaluate(async () => {
        const list = (await (await window.SalesHub.api.fetch("/records/leads/")).json()).records;
        for (const r of list) await window.SalesHub.api.fetch(`/records/leads/${r.id}`, { method: "DELETE" });
      });
      await page.evaluate(() => window.SalesHub.sync.pull());
      assert.equal(await page.evaluate(() => window.SalesHub.state.leads.length), count, "no local leads were dropped");
      await waitFor(page, "leads uploaded again", async (n) => (await (await window.SalesHub.api.fetch("/records/leads/")).json()).records.length === n, count);
    });

    await step("every tab fits a phone screen without sideways scrolling", async () => {
      const mobile = await newPage(browser, errors, { viewport: { width: 390, height: 800 } });
      await signIn(mobile, REP);
      for (const t of ["today", "prospecting", "compare", "quotes", "accounts"]) {
        await tab(mobile, t);
        const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `${t}: page is ${overflow}px wider than the screen`);
      }
      await mobile.context().close();
    });

    if (process.env.AXE_PATH) {
      // Optional: AXE_PATH=/path/to/axe.min.js (npm i axe-core). Runs WCAG 2.2 A/AA rules on screens with data and panels open.
      await step("axe finds no WCAG A/AA violations on populated screens, light and dark", async () => {
        const axeSrc = fs.readFileSync(process.env.AXE_PATH, "utf8");
        const problems = [];
        for (const scheme of ["light", "dark"]) {
          // reduced motion: axe samples colours mid-fade otherwise and reports blended, transient values
          const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: "reduce", viewport: { width: 1280, height: 900 } });
          const pg = await newPage(browser, errors, { context: ctx });
          await signIn(pg, REP);
          await pg.evaluate(() => window.SalesHub.sync.enableQuotes());
          await waitFor(pg, "data arrives", () => window.SalesHub.state.quotes.length > 0 && window.SalesHub.state.accounts.length > 0);
          const check = async (name) => {
            await pg.waitForTimeout(400);
            await pg.evaluate(axeSrc);
            const found = await pg.evaluate(async () => (await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } })).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`));
            for (const f of found) problems.push(`[${scheme}] ${name}: ${f}`);
          };
          for (const t of ["today", "prospecting", "compare", "quotes", "accounts"]) { await tab(pg, t); await check(t); }
          await tab(pg, "quotes");
          await pg.click("#q-rows tr"); await pg.waitForSelector("#quote-editor:not([hidden])"); await check("quote editor");
          await pg.click('[data-pick="new"]'); await pg.waitForSelector("#item-picker:not([hidden])"); await check("item picker");
          await pg.keyboard.press("Escape"); await pg.keyboard.press("Escape");
          await tab(pg, "accounts");
          await pg.click("#backup-open"); await pg.waitForSelector("#backup-modal:not([hidden])"); await check("backup dialog");
          await pg.keyboard.press("Escape");
          await ctx.close();
        }
        assert.deepEqual(problems, []);
      });
    }

    await step("no unexpected browser errors during the whole flow", async () => {
      assert.deepEqual(errors, []);
    });
  } finally {
    await browser.close();
    console.log(`${passed} steps passed`);
  }
})().catch(() => { process.exitCode = 1; });
