// Aegis — unit tests for lib/domainAnalysis.js
// Plain Node + assert, no test framework — matches REFERENCE.md §9:
// "Unit-test domainAnalysis.js in isolation... this is the easiest part
// to get a fast feedback loop on."
//
// Run: npm test

const assert = require("node:assert/strict");
const {
  getRegistrableDomain,
  isPunycode,
  levenshtein,
  checkLookalike,
  isCombosquat,
  hasSuspiciousTld,
  findBrandInTitle,
  analyzeDomain,
  decodePunycode,
  checkHomograph,
} = require("../lib/domainAnalysis.js");
const { BRAND_LIST, SUSPICIOUS_TLDS, KNOWN_LEGIT_DOMAINS } = require("../lib/brandList.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}`);
    console.log(`         ${err.message}`);
  }
}

console.log("getRegistrableDomain()");
test("simple two-label domain", () => {
  assert.equal(getRegistrableDomain("paypal.com"), "paypal.com");
});
test("subdomain collapses to eTLD+1", () => {
  assert.equal(getRegistrableDomain("accounts.google.com"), "google.com");
  assert.equal(getRegistrableDomain("mail.google.com"), "google.com");
});
test("known multi-label suffix (co.uk)", () => {
  assert.equal(getRegistrableDomain("www.example.co.uk"), "example.co.uk");
});
test("unknown hostname / null-safe", () => {
  assert.equal(getRegistrableDomain(null), null);
  assert.equal(getRegistrableDomain(""), null);
});

console.log("\nisPunycode()");
test("flags xn-- labels", () => {
  assert.equal(isPunycode("xn--pypal-4ve.com"), true);
});
test("ignores normal domains", () => {
  assert.equal(isPunycode("paypal.com"), false);
});

console.log("\nlevenshtein()");
test("identical strings are distance 0", () => {
  assert.equal(levenshtein("paypal", "paypal"), 0);
});
test("single substitution is distance 1", () => {
  assert.equal(levenshtein("paypal", "paypa1"), 1);
});

console.log("\ncheckLookalike()");
test("flags a 1-edit typosquat", () => {
  const hits = checkLookalike("paypa1.com", BRAND_LIST);
  assert.ok(hits.some((h) => h.brand === "paypal" && h.distance === 1));
});
test("does not flag the real brand domain", () => {
  const hits = checkLookalike("paypal.com", BRAND_LIST);
  assert.equal(hits.length, 0);
});
test("does not flag an unrelated domain", () => {
  const hits = checkLookalike("example.com", BRAND_LIST);
  assert.equal(hits.length, 0);
});

console.log("\nisCombosquat()");
test("flags brand name stuffed into an unrelated domain's subdomain", () => {
  const host = "paypal.com.security-check.xyz";
  const reg = getRegistrableDomain(host);
  assert.equal(isCombosquat(host, reg, BRAND_LIST), true);
});
test("does not flag the brand's own domain", () => {
  const host = "www.paypal.com";
  const reg = getRegistrableDomain(host);
  assert.equal(isCombosquat(host, reg, BRAND_LIST), false);
});

console.log("\nhasSuspiciousTld()");
test("flags a commonly-abused TLD", () => {
  assert.equal(hasSuspiciousTld("secure-login.tk", SUSPICIOUS_TLDS), true);
});
test("does not flag .com", () => {
  assert.equal(hasSuspiciousTld("paypal.com", SUSPICIOUS_TLDS), false);
});

console.log("\nanalyzeDomain() — end to end");
test("combosquat URL scores as combosquat + suspicious TLD", () => {
  const result = analyzeDomain(
    "https://paypal.com.security-check.xyz/login",
    BRAND_LIST,
    SUSPICIOUS_TLDS
  );
  assert.equal(result.registrableDomain, "security-check.xyz");
  assert.equal(result.isCombosquat, true);
  assert.equal(result.suspiciousTld, true);
});
test("legit brand domain is clean", () => {
  const result = analyzeDomain("https://www.paypal.com/signin", BRAND_LIST, SUSPICIOUS_TLDS);
  assert.equal(result.closestBrand, null);
  assert.equal(result.isCombosquat, false);
});
test("typosquat URL surfaces closestBrand", () => {
  const result = analyzeDomain("https://paypa1.com/login", BRAND_LIST, SUSPICIOUS_TLDS);
  assert.equal(result.closestBrand?.brand, "paypal");
  assert.equal(result.closestBrand?.distance, 1);
});
test("malformed URL fails safe (no throw)", () => {
  const result = analyzeDomain("not a url", BRAND_LIST, SUSPICIOUS_TLDS);
  assert.equal(result.hostname, null);
  assert.equal(result.registrableDomain, null);
});

console.log("\nfindBrandInTitle()");
test("flags a brand in the title when the domain is unrelated", () => {
  assert.equal(findBrandInTitle("PayPal - Log in", "secure-check.xyz", BRAND_LIST), "paypal");
});
test("does not flag the brand's own domain", () => {
  assert.equal(findBrandInTitle("PayPal - Log in", "paypal.com", BRAND_LIST), null);
});
test("matches whole words only (ups must not match inside 'groups')", () => {
  assert.equal(findBrandInTitle("Study groups near you", "example.com", BRAND_LIST), null);
});
test("is case-insensitive", () => {
  assert.equal(findBrandInTitle("MICROSOFT Account", "login-help.top", BRAND_LIST), "microsoft");
});
test("null-safe on empty title / domain", () => {
  assert.equal(findBrandInTitle("", "example.com", BRAND_LIST), null);
  assert.equal(findBrandInTitle("PayPal", null, BRAND_LIST), null);
});

const A = (url) => analyzeDomain(url, BRAND_LIST, SUSPICIOUS_TLDS, KNOWN_LEGIT_DOMAINS);

console.log("\nv0.3 detection upgrades");
test("typo + extra word is caught by word-level matching (micros0ft-support)", () => {
  const r = A("https://micros0ft-support.com/");
  assert.equal(r.closestBrand?.brand, "microsoft");
  assert.equal(r.closestBrand?.distance, 1);
});
test("unlisted-before brand now covered (sbi as a whole word)", () => {
  assert.equal(A("https://sbi-netbanking-kyc.icu/").isCombosquat, true);
});
test("brand as TLD is not a combosquat (onlinesbi.sbi)", () => {
  assert.equal(A("https://onlinesbi.sbi/").isCombosquat, false);
});
test("short brands do not match inside words (firstbank vs irs)", () => {
  assert.equal(A("https://www.firstbank.com/").isCombosquat, false);
});
test("short brands: ubs.com is not a lookalike of ups", () => {
  assert.equal(A("https://www.ubs.com/").closestBrand, null);
});
test("4-5 letter brands only match leetspeak edits (app1e yes, apps no)", () => {
  assert.equal(A("https://app1e.com/").closestBrand?.brand, "apple");
  assert.equal(A("https://apps.com/").closestBrand, null);
});
test("long brands tolerate two edits, mid-length only one (icicibank is not citibank)", () => {
  assert.equal(A("https://www.icicibank.com/").closestBrand, null);
  assert.equal(A("https://wellsfarg0.com/").closestBrand?.brand, "wellsfargo");
});
test("double digit-for-letter swaps are caught by leetspeak normalisation (faceb00k, g00gle)", () => {
  assert.equal(A("https://faceb00k.com/").closestBrand?.brand, "facebook");
  assert.equal(A("https://g00gle.tk/").closestBrand?.brand, "google");
});
test("Indian bank short names are covered (hdfc-kyc-update) without flagging hdfcbank.com", () => {
  assert.equal(A("https://hdfc-kyc-update.icu/").isCombosquat, true);
  assert.equal(A("https://netbanking.hdfcbank.com/").isCombosquat, false);
  assert.equal(A("https://www.icicibank.com/").isCombosquat, false);
});
test("brand embedded in a long word still flags (paypalverify.com)", () => {
  assert.equal(A("https://paypalverify.com/").isCombosquat, true);
});
test("known legitimate brand-owned domains are skipped", () => {
  for (const u of ["https://login.microsoftonline.com/", "https://s3.amazonaws.com/", "https://www.paypay.com/", "https://static.cdninstagram.com/"]) {
    const r = A(u);
    assert.equal(r.isCombosquat, false, u);
    assert.equal(r.closestBrand, null, u);
  }
});
test("real brand domains and subdomains are untouched", () => {
  for (const u of ["https://www.paypal.com/", "https://accounts.google.com/", "https://netbanking.hdfcbank.com/", "https://www.irctc.co.in/"]) {
    const r = A(u);
    assert.equal(r.isCombosquat, false, u);
    assert.equal(r.closestBrand, null, u);
  }
});
test("punycode decoder matches RFC 3492 examples", () => {
  assert.equal(decodePunycode("pypal-4ve"), "p\u0430ypal");
  assert.equal(decodePunycode("80ak6aa92e"), "\u0430\u0440\u0440\u04CF\u0435");
  assert.equal(decodePunycode("bcher-kva"), "b\u00FCcher");
  assert.equal(decodePunycode("!!"), null);
});
test("mixed-script homograph of paypal is detected as that brand", () => {
  const h = checkHomograph("xn--pypal-4ve.com", BRAND_LIST);
  assert.equal(h.mixedScript, true);
  assert.equal(h.brand, "paypal");
});
test("all-Cyrillic spoof of apple is detected by skeleton", () => {
  assert.equal(A("https://xn--80ak6aa92e.com/").homographBrand, "apple");
});
test("harmless IDN (german umlaut) is not a brand homograph", () => {
  const r = A("https://xn--bcher-kva.example/");
  assert.equal(r.homographBrand, null);
  assert.equal(r.mixedScript, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
