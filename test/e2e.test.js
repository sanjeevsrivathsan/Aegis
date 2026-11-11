// Aegis end-to-end test: loads the UNPACKED extension into real Chromium
// and drives it against the local test server (started and stopped here).
// No fake chrome.* anywhere in this file.
//
// Needs Playwright (not a runtime dependency of the extension):
//   npm i -D playwright && npx playwright install chromium
//   npm run test:e2e
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const PORT = 5599;
const BASE = `http://localhost:${PORT}`;
let server = null;
let failures = 0;
const check = (label, cond, extra = "") => {
  console.log(`${cond ? "ok   " : "FAIL "}- ${label}${extra ? "  " + extra : ""}`);
  if (!cond) failures++;
};

(async () => {
  server = spawn(process.execPath, [path.join(ROOT, "test-server/server.js")], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 800));

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium", // new headless mode, which supports extensions
    headless: true,
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extId = sw.url().split("/")[2];
  check("extension loads and its service worker starts", sw.url().endsWith("/background.js"), `(id ${extId.slice(0, 8)}…)`);

  const riskFor = async (urlPart) =>
    sw.evaluate(async (part) => {
      const all = await chrome.storage.session.get(null);
      const hits = Object.entries(all).filter(([k, v]) => k.startsWith("tabRisk:") && v.url && v.url.includes(part));
      hits.sort((a, b) => b[1].updatedAt - a[1].updatedAt);
      return hits[0] ? hits[0][1] : null;
    }, urlPart);
  const settle = (page, ms = 900) => page.waitForTimeout(ms);
  const reasonIds = (r) => (r ? r.reasons.map((x) => x.id) : []);

  // install defaults
  // onInstalled is async and fires shortly after the worker starts, so poll.
  let stored = {};
  let waitedMs = 0;
  for (; waitedMs < 5000; waitedMs += 250) {
    stored = await sw.evaluate(() => chrome.storage.local.get(null));
    if (stored.settings) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check("install defaults written (incl. theme + empty allowlist)", stored.settings?.theme === "system" && Array.isArray(stored.allowlist), "(after " + waitedMs + "ms; " + JSON.stringify(stored) + ")");

  // 1. clean page
  let page = await context.newPage();
  await page.goto(`${BASE}/clean.html`);
  await settle(page);
  let r = await riskFor("/clean.html");
  check("clean page scores 0", r && r.score === 0, r ? `(score ${r.score})` : "(no result)");
  check("clean page shows no banner", (await page.locator("#phishguard-warning-banner").count()) === 0);

  // 2. password over HTTP
  await page.goto(`${BASE}/password-http.html`);
  await settle(page);
  r = await riskFor("/password-http.html");
  check("password-on-HTTP page flagged", reasonIds(r).includes("password_http"), `(${reasonIds(r).join(", ")})`);

  // 3. brand in title + password
  await page.goto(`${BASE}/brand-mismatch.html`);
  await settle(page);
  r = await riskFor("/brand-mismatch.html");
  check("brand-mismatch page flagged with brand_title_mismatch", reasonIds(r).includes("brand_title_mismatch"), `(${reasonIds(r).join(", ")}, score ${r?.score})`);
  check("medium score (40) does not show a banner by default", r?.level === "medium" && (await page.locator("#phishguard-warning-banner").count()) === 0);

  // 4. real redirect chain through the browser
  await page.goto(`${BASE}/redirect/start`);
  await settle(page);
  r = await riskFor("/redirect/final.html");
  check("4 real 302 hops counted exactly (no double count)", r && r.chainLength === 4, r ? `(chainLength ${r.chainLength})` : "(no result)");
  check("long chain adds chain_length reason", reasonIds(r).includes("chain_length"));

  // 4b. login form rendered AFTER document_end (MutationObserver path)
  await page.goto(`${BASE}/late-login.html`);
  await page.waitForTimeout(400);
  r = await riskFor("/late-login.html");
  check("late page: no password field yet, so no brand_title_mismatch", !reasonIds(r).includes("brand_title_mismatch"), `(${reasonIds(r).join(", ") || "none"})`);
  await page.waitForTimeout(2200);
  r = await riskFor("/late-login.html");
  check("late-injected login form is picked up by the observer", reasonIds(r).includes("brand_title_mismatch"), `(${reasonIds(r).join(", ") || "none"}, score ${r?.score})`);

  // 5. banner round trip: content script <-> service worker
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...settings, showBannerOnMedium: true } });
  });
  await page.goto(`${BASE}/brand-mismatch.html`);
  await page.waitForSelector("#phishguard-warning-banner.pg-visible", { timeout: 5000 }).catch(() => {});
  check("medium banner appears once enabled (full content-script round trip)", (await page.locator("#phishguard-warning-banner.pg-visible").count()) === 1);
  const bannerText = await page.locator("#phishguard-warning-banner").innerText().catch(() => "");
  check("banner shows score and a reason", /score 40/.test(bannerText) && /PayPal|paypal/.test(bannerText), `("${bannerText.split("\n").find((l) => l.includes("Aegis")) || bannerText.slice(0, 40)}")`);
  await page.screenshot({ path: path.join(os.tmpdir(), "e2e-banner.png") });

  await page.click('#phishguard-warning-banner button:has-text("Dismiss")');
  await page.waitForTimeout(500);
  check("Dismiss removes the banner", (await page.locator("#phishguard-warning-banner").count()) === 0);
  await page.goto(`${BASE}/brand-mismatch.html`);
  await settle(page);
  check("dismissal persists on same site after reload", (await page.locator("#phishguard-warning-banner").count()) === 0);

  // 6. allowlist clears the page
  await sw.evaluate(() => chrome.storage.local.set({ allowlist: ["localhost"] }));
  await page.goto(`${BASE}/password-http.html`);
  await settle(page);
  r = await riskFor("/password-http.html");
  check("allowlisted host scores 0", r && r.allowlisted === true && r.score === 0);
  await sw.evaluate(() => chrome.storage.local.set({ allowlist: [] }));

  // 7. options page in real extension context
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options/options.html`);
  await opt.waitForTimeout(500);
  check("options page loads as an extension page", (await opt.title()) === "Aegis Settings");
  await opt.click('#themeSegmented button[data-value="dark"]');
  await opt.waitForTimeout(400);
  const themeInStorage = await sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings.theme);
  check("theme choice saved to real chrome.storage", themeInStorage === "dark");
  check("options page applied dark theme", (await opt.evaluate(() => document.documentElement.dataset.theme)) === "dark");
  await opt.screenshot({ path: path.join(os.tmpdir(), "e2e-options.png") });

  // 8. popup renders real data for a page (opened as a tab; target chosen explicitly)
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForTimeout(600);
  const popupText = await popup.locator("#content").innerText();
  check("popup loads and handles a non-http tab gracefully", /only scans http/i.test(popupText), `("${popupText.trim().slice(0, 50)}")`);

  // 9. no console errors from the extension's own pages
  const errs = [];
  opt.on("pageerror", (e) => errs.push(e.message));
  await opt.reload();
  await opt.waitForTimeout(400);
  check("no page errors on the options page", errs.length === 0, errs.join("; "));

  await context.close();
  server.kill();
  console.log(`\n${failures === 0 ? "E2E PASSED (real Chromium, unpacked extension)" : failures + " E2E CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("E2E CRASHED:", e.message);
  if (server) server.kill();
  process.exit(2);
});
