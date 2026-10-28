const browser = ["window","document","localStorage","fetch","FormData","Headers","Blob","URL","setTimeout","clearTimeout","setInterval","clearInterval","confirm","alert","location","navigator","Option","Storage","DOMException","CustomEvent","Event","console","google","Intl","requestAnimationFrame","crypto","File","FileReader","performance","history","getComputedStyle","matchMedia","MutationObserver","IntersectionObserver","HTMLElement","Node","structuredClone","module","globalThis","BigInt","self","atob","btoa","TextDecoder","AbortController"];
module.exports = [{
  files: ["frontend/*.js", "tests/js/*.js", "tests/e2e/*.js"],
  languageOptions: { ecmaVersion: 2022, sourceType: "script", globals: Object.fromEntries(browser.map((g) => [g, "readonly"]).concat([["require","readonly"],["process","readonly"],["__dirname","readonly"],["axe","readonly"]])) },
  rules: { "no-undef": "error", "no-unused-vars": ["warn", { args: "none", caughtErrors: "none" }], "no-redeclare": "error", "no-dupe-keys": "error", "no-unreachable": "error", "eqeqeq": ["warn", "always", { null: "ignore" }] },
}];
