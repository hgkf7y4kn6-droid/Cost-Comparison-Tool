// Store screenshots from the running app, with fictional data only.
//   node scripts/store_screenshots.js http://127.0.0.1:8000 reviewer@example.com 'PASSWORD'
// Needs Playwright (npm i -D playwright, or the one pre-installed in the cloud sandbox). Writes store/screenshots/<device>/NN-name.png.
// The Find customers shot uses made-up results so it looks the same whether or not API keys are configured.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const [base = "http://127.0.0.1:8000", email, password] = process.argv.slice(2);
if (!email || !password) {
  console.error("usage: node scripts/store_screenshots.js BASE_URL EMAIL PASSWORD");
  process.exit(2);
}
const DEVICES = {
  "iphone-6.9": { width: 440, height: 956, scale: 3 }, // 1320x2868
  "ipad-13": { width: 1032, height: 1376, scale: 2 }, // 2064x2752
  "android-phone": { width: 360, height: 640, scale: 3 }, // 1080x1920
};
const FINDER = {
  found: 3, notes: [], remaining: 142,
  results: [
    { company: "Riverside Medical Associates", address: "1200 Market St", city: "Philadelphia", state: "PA", zip: "19103", employees: 34, phone: "(215) 555-0111", website: "riverside-medical.example", contactName: "Dana Reyes", contactTitle: "Facilities Manager", fit: 82, source: "Google Maps + Apollo", placeId: "s1", lat: 39.95, lng: -75.16 },
    { company: "Walnut Street Hotel", address: "50 N 6th St", city: "Philadelphia", state: "PA", zip: "19106", employees: 58, phone: "(215) 555-0122", website: "walnut-hotel.example", fit: 71, source: "Google Maps + Apollo", placeId: "s2", lat: 39.95, lng: -75.15 },
    { company: "Bayview Warehousing", address: "8 Kings Hwy", city: "Cherry Hill", state: "NJ", zip: "08002", employees: "", phone: "(856) 555-0133", website: "bayview-warehousing.example", fit: 55, source: "Google Maps", placeId: "s3", lat: 39.93, lng: -75.03 },
  ],
};

(async () => {
  const browser = await chromium.launch();
  for (const [name, d] of Object.entries(DEVICES)) {
    const out = path.join(__dirname, "..", "store", "screenshots", name);
    fs.mkdirSync(out, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: d.width, height: d.height }, deviceScaleFactor: d.scale, isMobile: d.width < 700, hasTouch: true });
    const page = await ctx.newPage();
    await page.route("**/finder/status", (r) => r.fulfill({ json: { google: true, apollo: true, remaining: 150, areas: { philadelphia: "Philadelphia & suburbs" }, segments: { janitorial: "Janitorial supplies (facility-heavy buyers)", furniture: "Commercial furniture projects (new, moving or renovating)", branded: "Branded & promotional products", uniforms: "Purchased uniforms & work apparel" }, defaults: { min_employees: 20, max_employees: 500 } } }));
    await page.route("**/finder/search", (r) => r.fulfill({ json: FINDER }));
    await page.goto(base);
    await page.fill("#signin-email", email);
    await page.fill("#signin-password", password);
    await page.click("#signin-form button[type=submit]");
    await page.waitForSelector("#signin", { state: "hidden" });
    await page.evaluate(() => localStorage.setItem(`ob.ai.consent.${SalesHub.auth.email}`, "declined"));
    const shot = async (n, label) => {
      await page.waitForTimeout(500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(out, `${n}-${label}.png`) });
    };
    if (await page.isVisible("#start-sample")) await page.click("#start-sample");
    await page.click("#tab-btn-today");
    await page.waitForTimeout(400);
    await shot("01", "today");
    await page.click("#tab-btn-prospecting");
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("saleshub:signedin")));
    await page.waitForSelector("#finder-go");
    await page.click("#finder-go");
    await page.waitForSelector("#finder-rows tr");
    await page.evaluate(() => document.querySelector('[data-card="customer-finder"]').scrollIntoView());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, "02-find-customers.png") });
    await page.click("#tab-btn-coach");
    await page.waitForSelector(".coach-persona");
    await page.click("#coach-personas .coach-persona >> nth=2");
    await page.click(".coach-starters .btn >> nth=0");
    await page.waitForSelector(".coach-msg.assistant:not(.pending)");
    await shot("03", "coach");
    await page.click('[data-card="coach-knowledge"] .xcard-head');
    await page.locator(".kb-entry summary", { hasText: "Perception matters" }).click();
    await page.evaluate(() => document.querySelector('[data-card="coach-knowledge"]').scrollIntoView());
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(out, "04-playbook.png") });
    await ctx.close();
  }
  await browser.close();
  console.log("wrote store/screenshots/");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
