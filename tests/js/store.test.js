// Browser storage rules (store.js, backup.js) run in a sandbox with a fake localStorage.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Objects created inside the sandbox are a different realm, so compare their JSON.
const same = (a, b, m) => assert.equal(JSON.stringify(a), JSON.stringify(b), m);
const read = (f) => fs.readFileSync(path.join(__dirname, "../../frontend", f), "utf8");

function makeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  const s = {
    failWrites: false,
    blocked: false,
    getItem(k) { if (s.blocked) throw new Error("blocked"); return data.has(k) ? data.get(k) : null; },
    setItem(k, v) { if (s.blocked || s.failWrites) { const e = new Error("quota"); e.name = "QuotaExceededError"; throw e; } data.set(k, String(v)); },
    removeItem(k) { data.delete(k); },
    get length() { return data.size; },
    _data: data,
  };
  // Object.keys(localStorage) must list the stored keys, like the real thing.
  return new Proxy(s, { ownKeys: () => [...data.keys()], getOwnPropertyDescriptor: (t, k) => (data.has(k) ? { enumerable: true, configurable: true, value: data.get(k) } : Reflect.getOwnPropertyDescriptor(t, k)) });
}

function loadStore(initial = {}) {
  const localStorage = makeStorage(initial);
  const win = { addEventListener() {} };
  const sandbox = { window: win, localStorage, console, Date, JSON, Math, Object, Array, Number, String, Blob: class {}, URL: { createObjectURL() { return ""; }, revokeObjectURL() {} }, document: { createElement: () => ({ click() {} }) }, setTimeout };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read("calc.js"), sandbox);
  win.SalesCalc = sandbox.window.SalesCalc;
  vm.runInContext(read("store.js"), sandbox);
  return { hub: sandbox.window.SalesHub, localStorage, sandbox };
}

const KEY = "ob.prospecting.v1";

test("a fresh browser starts empty at the current schema version", () => {
  const { hub } = loadStore();
  assert.equal(hub.state.schemaVersion, hub.persistence.SCHEMA_VERSION);
  same([hub.state.leads, hub.state.quotes, hub.state.accounts], [[], [], []]);
});

test("version-1 data (no schemaVersion) loads and is migrated without losing anything", () => {
  const v1 = { leads: [{ id: "L1" }], quotes: [{ id: "Q1", lines: [] }], accounts: [{ id: "A1" }], counters: { "quote-2026": 4 }, settings: { targetMargin: 33 } };
  const { hub } = loadStore({ [KEY]: JSON.stringify(v1) });
  assert.equal(hub.state.quotes[0].id, "Q1");
  assert.equal(hub.state.counters["quote-2026"], 4);
  assert.equal(hub.state.settings.targetMargin, 33);
  assert.equal(hub.state.schemaVersion, 2);
  assert.equal(hub.persistence.notices.size, 0);
});

test("unreadable JSON is set aside, reported, and the app starts empty", () => {
  const { hub, localStorage } = loadStore({ [KEY]: '{"quotes":[{"id":"Q1"' });
  same(hub.state.quotes, []);
  const copies = [...localStorage._data.keys()].filter((k) => k.startsWith(hub.persistence.CORRUPT_PREFIX));
  assert.equal(copies.length, 1);
  assert.equal(localStorage._data.get(copies[0]), '{"quotes":[{"id":"Q1"');
  assert.match(hub.persistence.notices.get("corrupt").text, /couldn't be read/);
});

test("if the set-aside copy can't be written the original is left alone and saving is disabled", () => {
  const storage = makeStorage({ [KEY]: "{broken" });
  storage.failWrites = true;
  const sandbox = { window: { addEventListener() {} }, localStorage: storage, console, Date, JSON, Math, Object, Array, Number, String, Blob: class {}, URL: {}, document: {}, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(read("calc.js"), sandbox);
  sandbox.window.SalesCalc = sandbox.window.SalesCalc;
  vm.runInContext(read("store.js"), sandbox);
  const hub = sandbox.window.SalesHub;
  hub.state.quotes.push({ id: "new" });
  storage.failWrites = false;
  hub.save();
  assert.equal(storage._data.get(KEY), "{broken", "the unreadable value is never overwritten without a copy");
});

test("wrongly-typed fields and junk records are set aside, the rest loads", () => {
  const data = { leads: "not a list", quotes: [{ id: "Q1" }, null, 7, ["x"]], accounts: [{ id: "A1" }], settings: [] };
  const { hub, localStorage } = loadStore({ [KEY]: JSON.stringify(data) });
  same(hub.state.leads, []);
  same(hub.state.quotes.map((q) => q.id), ["Q1"]);
  assert.equal(hub.state.accounts.length, 1);
  assert.ok([...localStorage._data.keys()].some((k) => k.startsWith(hub.persistence.CORRUPT_PREFIX)));
  assert.match(hub.persistence.notices.get("partial").text, /unexpected format/);
});

test("data from a newer version is never overwritten by this one", () => {
  const raw = JSON.stringify({ schemaVersion: 99, quotes: [{ id: "Q-future" }], futureField: true });
  const { hub, localStorage } = loadStore({ [KEY]: raw });
  hub.state.quotes.push({ id: "Q-local" });
  hub.save();
  assert.equal(localStorage._data.get(KEY), raw);
  assert.match(hub.persistence.notices.get("newer").text, /newer version/);
});

test("a full or blocked store is reported and recovers when saving works again", () => {
  const { hub, localStorage } = loadStore();
  localStorage.failWrites = true;
  hub.save();
  assert.match(hub.persistence.notices.get("save").text, /could not be saved/);
  assert.equal(hub.persistence.status().ok, false);
  localStorage.failWrites = false;
  hub.save();
  assert.equal(hub.persistence.notices.has("save"), false);
  assert.equal(hub.persistence.status().ok, true);
});

test("storage that throws on read (private mode) doesn't crash startup", () => {
  const storage = makeStorage();
  storage.blocked = true;
  const sandbox = { window: { addEventListener() {} }, localStorage: storage, console, Date, JSON, Math, Object, Array, Number, String, Blob: class {}, URL: {}, document: {}, setTimeout };
  vm.createContext(sandbox);
  vm.runInContext(read("calc.js"), sandbox);
  vm.runInContext(read("store.js"), sandbox);
  assert.match(sandbox.window.SalesHub.persistence.notices.get("storage").text, /blocking storage/);
});

test("a second person signing in gets their own data; the first person's returns later, catalog included", () => {
  const { hub, localStorage } = loadStore();
  const P = hub.persistence;
  assert.ok(P.adoptUser("ana@x.com"));
  hub.state.quotes.push({ id: "Qana", lines: [{ cost: 5 }] });
  hub.state.leads.push({ id: "Lana" });
  localStorage.setItem(P.CATALOG_KEY, '{"items":[{"sku":"A","cost":1}]}');
  hub.save();

  assert.ok(P.adoptUser("raj@x.com"));
  same(hub.state.quotes, [], "raj does not see ana's proposals");
  assert.equal(hub.state.localOwner, "raj@x.com");
  assert.equal(localStorage.getItem(P.CATALOG_KEY), null, "…or her supplier costs");
  assert.ok(localStorage.getItem(`${KEY}.user.ana@x.com`), "ana's data is kept, not deleted");

  hub.state.quotes.push({ id: "Qraj" });
  assert.ok(P.adoptUser("ANA@x.com"));
  same(hub.state.quotes.map((q) => q.id), ["Qana"]);
  same(hub.state.leads.map((q) => q.id), ["Lana"]);
  assert.match(localStorage.getItem(P.CATALOG_KEY), /"sku":"A"/);
  assert.ok(P.adoptUser("raj@x.com"));
  same(hub.state.quotes.map((q) => q.id), ["Qraj"]);
});

test("if the first person's data can't be set aside, the switch is refused and nothing is lost", () => {
  const { hub, localStorage } = loadStore();
  hub.persistence.adoptUser("ana@x.com");
  hub.state.quotes.push({ id: "Qana" });
  hub.save();
  localStorage.failWrites = true;
  assert.equal(hub.persistence.adoptUser("raj@x.com"), false);
  same(hub.state.quotes.map((q) => q.id), ["Qana"]);
});

test("the first person to sign in claims data that predates per-person storage", () => {
  const { hub } = loadStore({ [KEY]: JSON.stringify({ quotes: [{ id: "Qold" }] }) });
  assert.ok(hub.persistence.adoptUser("ana@x.com"));
  same(hub.state.quotes.map((q) => q.id), ["Qold"]);
  assert.equal(hub.state.localOwner, "ana@x.com");
});
