// Aegis — service-worker logic tests.
// Loads the REAL background.js into a vm sandbox with a fake chrome.* API,
// then fires navigation/message events at it and inspects the results.
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const assert = require("node:assert/strict");

const ROOT = path.join(__dirname, "..");
const store = { local: {}, session: {} };
const listeners = {};
let redirectFilter = null;
const sentToTabs = [];

function area(name) {
  const pick = (keys) => {
    if (keys == null) return { ...store[name] };
    const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of list) if (k in store[name]) out[k] = store[name][k];
    return out;
  };
  return {
    get: async (keys) => pick(keys),
    set: async (obj) => void Object.assign(store[name], obj),
    remove: async (keys) => void [].concat(keys).forEach((k) => delete store[name][k]),
  };
}
const ev = (name) => ({ addListener: (fn) => (listeners[name] = fn) });

const chrome = {
  storage: { local: area("local"), session: area("session") },
  action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  tabs: {
    sendMessage: async (tabId, payload) => void sentToTabs.push({ tabId, payload }),
    get: async () => ({ url: "https://example.com/" }),
    onRemoved: ev("tabsRemoved"),
  },
  notifications: { create: () => {} },
  webNavigation: {
    onCommitted: ev("committed"),
    onBeforeNavigate: ev("beforeNavigate"),
    onCompleted: ev("completed"),
    onHistoryStateUpdated: ev("history"),
  },
  webRequest: {
    onBeforeRedirect: {
      addListener: (fn, filter) => {
        listeners.redirect = fn;
        redirectFilter = filter;
      },
    },
  },
  runtime: { onMessage: ev("message"), onInstalled: ev("installed") },
};

const sandbox = { chrome, console: { log() {}, error: console.error }, URL, setTimeout };
sandbox.self = sandbox;
sandbox.importScripts = (...files) =>
  files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f }));
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, "background.js"), "utf8"), sandbox, { filename: "background.js" });

const tick = () => new Promise((r) => setTimeout(r, 25));
const send = (message, sender = {}) =>
  new Promise((resolve) => {
    const keep = listeners.message(message, sender, resolve);
    if (!keep) resolve(undefined);
  });
const risk = (tabId) => store.session[`tabRisk:${tabId}`];

let failures = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`ok   - ${label}`);
  } catch (e) {
    failures++;
    console.log(`FAIL - ${label}\n       ${e.message}`);
  }
}
const redirect = (tabId, from, to) =>
  listeners.redirect({ tabId, url: from, redirectUrl: to, statusCode: 302 });
const nav = async (tabId, url, qualifiers = []) => {
  listeners.beforeNavigate({ frameId: 0, tabId, url });
  return { commit: async () => (listeners.committed({ frameId: 0, tabId, url, transitionQualifiers: qualifiers }), tick()) };
};

(async () => {
  await check("service worker loads and registers every listener", () => {
    for (const k of ["committed", "beforeNavigate", "completed", "history", "redirect", "message", "installed", "tabsRemoved"])
      assert.ok(listeners[k], `missing listener: ${k}`);
  });

  await check("redirect listener only watches main_frame requests (no subresource noise)", () => {
    assert.equal(JSON.stringify(redirectFilter.types), JSON.stringify(["main_frame"]));
  });

  await check("3 webRequest hops + server_redirect commit counts 3, not 4 (no double count)", async () => {
    const n = await nav(1, "http://a.test/final", ["server_redirect"]);
    redirect(1, "http://a.test/s", "http://a.test/h1");
    redirect(1, "http://a.test/h1", "http://a.test/h2");
    redirect(1, "http://a.test/h2", "http://a.test/final");
    await n.commit();
    assert.equal(risk(1).chainLength, 3);
  });

  await check("server_redirect alone (webRequest saw nothing) still counts 1 hop", async () => {
    const n = await nav(2, "http://b.test/landed", ["server_redirect"]);
    await n.commit();
    assert.equal(risk(2).chainLength, 1);
  });

  await check("client_redirect always counts, even alongside webRequest hops", async () => {
    const n = await nav(3, "http://c.test/landed", ["client_redirect"]);
    redirect(3, "http://c.test/a", "http://c.test/b");
    await n.commit();
    assert.equal(risk(3).chainLength, 2);
  });

  await check("brand in title + password field + unrelated domain => brand_title_mismatch", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: true, isHttps: true, title: "PayPal - Log in", url: "https://secure-check.example.net/login" } },
      { tab: { id: 10, url: "https://secure-check.example.net/login" } }
    );
    const r = risk(10);
    assert.ok(r.reasons.some((x) => x.id === "brand_title_mismatch"), JSON.stringify(r.reasons));
    assert.equal(r.score, 15);
  });

  await check("same title WITHOUT a password field is not scored", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: false, isHttps: true, title: "PayPal - Log in", url: "https://blog.example.net/post" } },
      { tab: { id: 11, url: "https://blog.example.net/post" } }
    );
    assert.equal(risk(11).reasons.some((x) => x.id === "brand_title_mismatch"), false);
  });

  await check("real brand domain with login form is not flagged", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: true, isHttps: true, title: "PayPal - Log in", url: "https://www.paypal.com/signin" } },
      { tab: { id: 12, url: "https://www.paypal.com/signin" } }
    );
    assert.equal(risk(12).score, 0);
  });

  await check("password-on-HTTP signal from the previous page does not leak into the next", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: true, isHttps: false, title: "x", url: "http://old.test/login" } },
      { tab: { id: 20, url: "http://old.test/login" } }
    );
    assert.ok(risk(20).reasons.some((x) => x.id === "password_http"));
    const n = await nav(20, "http://new.test/home");
    await n.commit();
    assert.equal(risk(20).reasons.some((x) => x.id === "password_http"), false);
  });

  await check("banner dismissal holds on the same site but not on a different domain", async () => {
    await send({ type: "DISMISS_BANNER" }, { tab: { id: 30, url: "https://a.example.com/x" } });
    const sameSite = await send({ type: "IS_BANNER_DISMISSED" }, { tab: { id: 30, url: "https://b.example.com/y" } });
    const otherSite = await send({ type: "IS_BANNER_DISMISSED" }, { tab: { id: 30, url: "https://other.org/z" } });
    assert.equal(sameSite.dismissed, true);
    assert.equal(otherSite.dismissed, false);
  });

  await check("tab close clears risk + dismissal state", async () => {
    store.session["tabRisk:40"] = { score: 1 };
    store.session["dismissed:40"] = "x.com";
    listeners.tabsRemoved(40);
    await tick();
    assert.equal(store.session["tabRisk:40"], undefined);
    assert.equal(store.session["dismissed:40"], undefined);
  });

  await check("popup REFRESH_TAB re-scores and returns fresh data", async () => {
    const r = await send({ type: "REFRESH_TAB", tabId: 50 }, {});
    assert.ok(r && typeof r.score === "number");
  });

  await check("allowlisted site scores 0 and is flagged allowlisted", async () => {
    store.local.allowlist = ["trusted.example"];
    const n = await nav(60, "https://login.trusted.example/");
    await n.commit();
    assert.equal(risk(60).allowlisted, true);
    assert.equal(risk(60).score, 0);
    store.local.allowlist = [];
  });

  await check("onInstalled keeps user choices and fills missing keys (theme)", async () => {
    store.local.settings = { sensitivity: "high" };
    store.local.allowlist = ["keep.me"];
    await listeners.installed();
    assert.deepEqual(JSON.parse(JSON.stringify(store.local.settings)), { sensitivity: "high", showBannerOnMedium: false, notifications: false, theme: "system" });
    assert.deepEqual(JSON.parse(JSON.stringify(store.local.allowlist)), ["keep.me"]);
  });

  await check("partial settings (theme only) don't break scoring", async () => {
    store.local.settings = { theme: "light" };
    const n = await nav(70, "https://paypa1.com/login");
    await n.commit();
    assert.equal(risk(70).level, "medium");
    assert.equal(risk(70).score, 30);
  });

  await check("password form on a lookalike domain adds login_on_lookalike (score 65 with brand title)", async () => {
    store.local.settings = { sensitivity: "medium" };
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: true, isHttps: true, title: "PayPal - Log in", url: "https://paypa1.com/login" } },
      { tab: { id: 80, url: "https://paypa1.com/login" } }
    );
    const r = risk(80);
    const ids = r.reasons.map((x) => x.id);
    assert.ok(ids.includes("lookalike") && ids.includes("login_on_lookalike") && ids.includes("brand_title_mismatch"), ids.join());
    assert.equal(r.score, 65);
    assert.equal(r.level, "high");
  });

  await check("login form alone on an unrelated domain is NOT scored (no impersonation)", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: true, isHttps: true, title: "Sign in", url: "https://acme-portal.example.net/" } },
      { tab: { id: 81, url: "https://acme-portal.example.net/" } }
    );
    assert.equal(risk(81).score, 0);
  });

  await check("homograph domain scores homograph_brand + punycode", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: false, isHttps: true, title: "x", url: "https://xn--pypal-4ve.com/" } },
      { tab: { id: 82, url: "https://xn--pypal-4ve.com/" } }
    );
    const ids = risk(82).reasons.map((x) => x.id);
    assert.ok(ids.includes("homograph_brand") && ids.includes("punycode"), ids.join());
  });

  await check("known brand-owned CDN domain is not flagged (s3.amazonaws.com)", async () => {
    await send(
      { type: "PAGE_SIGNALS", data: { hasPasswordField: false, isHttps: true, title: "x", url: "https://s3.amazonaws.com/bucket" } },
      { tab: { id: 83, url: "https://s3.amazonaws.com/bucket" } }
    );
    assert.equal(risk(83).score, 0);
  });

  console.log(`\n${failures === 0 ? "service-worker checks passed" : failures + " CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
