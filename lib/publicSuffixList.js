// Aegis — simplified Public Suffix List
//
// Full eTLD+1 parsing needs the real list at https://publicsuffix.org/list/ —
// this is a hand-picked subset of the multi-label suffixes you'll actually
// run into during testing (paypal.co.uk, example.com.au, etc). It's a known
// limitation, called out in REFERENCE.md §4.1: swap in the real PSL (or a
// maintained npm package like `psl`) before relying on this for anything
// beyond a learning project.

const MULTI_LABEL_SUFFIXES = new Set([
  // United Kingdom
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "gov.uk", "ac.uk", "sch.uk",
  // Japan
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  // South Korea
  "co.kr", "or.kr", "ne.kr", "go.kr",
  // Australia
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  // New Zealand
  "co.nz", "org.nz", "govt.nz", "net.nz",
  // South Africa
  "co.za", "org.za", "gov.za", "net.za",
  // Brazil
  "com.br", "net.br", "org.br", "gov.br",
  // Mexico
  "com.mx", "org.mx", "gob.mx", "net.mx",
  // China / Taiwan / Hong Kong / Singapore
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.tw", "net.tw", "org.tw", "gov.tw",
  "com.hk", "org.hk", "gov.hk", "net.hk",
  "com.sg", "org.sg", "gov.sg", "net.sg",
  // India
  "co.in", "net.in", "org.in", "gov.in", "firm.in", "gen.in", "ind.in",
  // Indonesia / Thailand / Philippines / Malaysia / Vietnam
  "co.id", "or.id", "go.id", "net.id",
  "co.th", "or.th", "go.th", "in.th",
  "com.ph", "org.ph", "gov.ph", "net.ph",
  "com.my", "org.my", "gov.my", "net.my",
  "com.vn", "org.vn", "gov.vn", "net.vn",
  // Turkey / Israel / Middle East
  "com.tr", "org.tr", "gov.tr", "net.tr",
  "co.il", "org.il", "gov.il", "net.il",
  "com.sa", "org.sa", "gov.sa", "net.sa",
  "com.eg", "org.eg", "gov.eg", "net.eg",
  // Latin America
  "com.ar", "org.ar", "gob.ar", "net.ar",
  "com.co", "org.co", "gov.co", "net.co",
  // Africa
  "com.ng", "org.ng", "gov.ng", "net.ng",
  "co.ke", "or.ke", "go.ke", "ne.ke",
]);

// In the service worker (loaded via importScripts), attach to the shared
// global scope so domainAnalysis.js can see it as a bare identifier.
if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.MULTI_LABEL_SUFFIXES = MULTI_LABEL_SUFFIXES;
}
// In Node (unit tests), export it normally.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { MULTI_LABEL_SUFFIXES };
}
