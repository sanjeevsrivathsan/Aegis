# Aegis — Detailed Technical Reference

Read this alongside `README.md`. Each section is a phase — build it, test it in the console, *then* move to the next one. Don't skip to the UI before the detection logic works and you can see it logging correctly.

---

## §1. Manifest V3 — the foundation

> **Important:** Manifest V3 is mandatory for new extensions. Manifest V2 background pages, blocking `webRequest`, and remotely hosted code are gone or heavily restricted. Everything below assumes MV3.

```json
{
  "manifest_version": 3,
  "name": "Aegis",
  "version": "0.1.0",
  "description": "Detects suspicious redirects and lookalike domains as pages load.",
  "permissions": [
    "webNavigation",
    "webRequest",
    "storage",
    "scripting",
    "activeTab",
    "notifications"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js"
  },
  "action": {
    "default_popup": "popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content-script.js"],
      "run_at": "document_end"
    }
  ],
  "options_page": "options/options.html"
}
```

**Highlighted gotchas:**

- **`host_permissions: ["<all_urls>"]`** is broad — Chrome will show users a scary-sounding permission ("read and change all your data on websites you visit"). That's expected for this kind of tool, but it's worth knowing *why* you need it: you must inspect the URL/domain of every page, not just ones the user explicitly grants via `activeTab`.
- **No `webRequestBlocking`.** You can still *observe* requests/redirects with plain `"webRequest"`, you just can't synchronously block/modify them the way MV2 extensions could. For a detector (vs. a blocker) this is fine.
- **Service workers are not persistent.** Unlike MV2 background pages, your `background.js` can be unloaded when idle and woken up on events. Don't rely on in-memory variables surviving indefinitely — for anything that must persist (recent navigation history, allowlist), use `chrome.storage.session` (in-memory but survives service worker restarts) or `chrome.storage.local` (persists to disk).

---

## §2. `chrome.webNavigation` — the primary sensor

This is the API you'll spend the most time with. It fires events as navigations happen, per tab and per frame (so it also sees iframes).

Key events:

| Event | Fires when |
|---|---|
| `onBeforeNavigate` | Browser is about to navigate a frame |
| `onCommitted` | Navigation has been committed (URL bar updated) — includes a `transitionQualifiers` array (e.g. `"client_redirect"`, `"server_redirect"`, `"forward_back"`) |
| `onHistoryStateUpdated` | SPA-style `history.pushState` navigation (no full page load) |
| `onCreatedNavigationTarget` | A link opened in a new tab/window |
| `onCompleted` | Navigation fully finished loading |
| `onErrorOccurred` | Navigation failed |

```js
// background.js
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return; // only care about the top-level frame for now
  console.log("Committed:", details.url, details.transitionQualifiers);

  if (details.transitionQualifiers.includes("server_redirect") ||
      details.transitionQualifiers.includes("client_redirect")) {
    // This navigation is itself a hop in a redirect chain
    recordRedirectHop(details.tabId, details.url);
  }
});
```

> **Important:** `transitionQualifiers` tells you *how* the browser got here (redirect vs. typed URL vs. link click vs. back/forward). This is your single richest signal for "was the user bounced here without clicking?"

---

## §3. `chrome.webRequest` — completing the redirect chain

`webNavigation` tells you about frame-level navigations, but a single navigation can involve multiple **server-side HTTP redirects** (301/302) that `webNavigation` collapses into one commit. To see every hop, use `webRequest.onBeforeRedirect`:

```js
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    appendToChain(details.tabId, {
      from: details.url,
      to: details.redirectUrl,
      statusCode: details.statusCode
    });
  },
  { urls: ["<all_urls>"] }
);
```

Maintain a per-tab chain, e.g.:

```js
const chains = new Map(); // tabId -> [{from, to, statusCode}, ...]

function appendToChain(tabId, hop) {
  if (!chains.has(tabId)) chains.set(tabId, []);
  chains.get(tabId).push(hop);
}

// Reset the chain when a brand-new top-level navigation starts
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId === 0) chains.set(details.tabId, []);
});
```

**Redirect-chain risk signals to score:**
- **Chain length** — 3+ hops before landing is more suspicious than a single hop
- **Domain hopping across unrelated domains** — `bank.com → bit.ly → sketchy-tld.xyz → bank-secure-login.tk` is far more suspicious than staying on subdomains of the same registrable domain
- **Mixed HTTPS→HTTP** — a downgrade mid-chain is a red flag
- **Final domain doesn't match the origin the user actually intended** (compare against a short "recently searched brand" hint if you build one later — optional/advanced)

---

## §4. Lookalike domain detection — the algorithm layer

This lives in `lib/domainAnalysis.js` and does **not** need any Chrome API — it's pure string/URL logic, which makes it the easiest part to unit test.

### 4.1 Parse the domain correctly

Use the URL API, and get the **registrable domain** (eTLD+1), not just `hostname`, so `mail.google.com` and `accounts.google.com` are correctly treated as the same registrable domain:

```js
function getHostname(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
```

> **Important:** For real eTLD+1 parsing (handling things like `.co.uk`) you eventually want the Public Suffix List. For a learning-stage project, a simplified "last two labels" heuristic is fine to start; note it as a known limitation.

### 4.2 Punycode / IDN homograph check

Attackers register domains using Unicode characters that *look* like Latin letters (e.g. Cyrillic "а" instead of Latin "a"). Chrome converts these to `xn--` punycode form internally.

```js
function isPunycode(hostname) {
  return hostname.split(".").some(label => label.startsWith("xn--"));
}
```

If `isPunycode(hostname)` is true, that alone is worth flagging for user review — it's not proof of phishing (plenty of legitimate international domains use it), but combined with a brand-name match it's a strong signal.

### 4.3 Levenshtein distance against a known-brand list

```js
// lib/domainAnalysis.js
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array(b.length + 1).fill(0)
  );
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function checkLookalike(hostname, brandList) {
  const domainCore = hostname.replace(/\.(com|net|org|co|io|xyz|tk|.*)$/, "");
  return brandList
    .map(brand => ({ brand, distance: levenshtein(domainCore, brand) }))
    .filter(r => r.distance > 0 && r.distance <= 2) // tune threshold
    .sort((a, b) => a.distance - b.distance);
}
```

`brandList` (in `lib/brandList.js`) is just an array you maintain: `["paypal", "microsoft", "apple", "google", "amazon", "netflix", ...]` — start with a handful of commonly-spoofed brands, expand later.

> **Important:** A small edit distance is a *hint*, not a verdict. `paypa1.com` (distance 1 from "paypal") is a strong signal. But plenty of legitimate small distances exist too — tune your threshold and always show the *reason*, not just a yes/no.

### 4.4 Common substitution / combosquatting patterns

Beyond edit distance, check for classic typosquatting techniques explicitly:

- **Character substitution**: `0`↔`o`, `1`↔`l`↔`i`, `rn`↔`m`, `vv`↔`w`
- **Extra subdomain / combosquatting**: brand name appears as a *subdomain* of an unrelated domain, e.g. `paypal.com.security-check.xyz` — the real registrable domain is `security-check.xyz`, not `paypal.com`. This is one of the most common real-world patterns and worth its own explicit check:

```js
function isCombosquat(hostname, brandList) {
  const labels = hostname.split(".");
  // brand appears somewhere in the subdomain labels, but is NOT the registrable domain itself
  const registrable = labels.slice(-2).join(".");
  return brandList.some(brand =>
    hostname.includes(brand) && !registrable.startsWith(brand)
  );
}
```

- **Suspicious TLD combined with brand keyword** — brand name + a TLD rarely used by that brand (`.tk`, `.xyz`, `.top`, `.click` are heavily abused; this is a soft signal, not a rule, since plenty of legitimate sites use them too)

---

## §5. Content script — DOM-level signals (optional but valuable)

`content-script.js` runs in the page and can check things `background.js` can't see:

```js
// content-script.js
function scanPage() {
  const hasPasswordField = !!document.querySelector('input[type="password"]');
  const isHttps = location.protocol === "https:";
  const hasBrandLogoText = /paypal|microsoft|apple|bank/i.test(document.title);

  chrome.runtime.sendMessage({
    type: "PAGE_SIGNALS",
    data: { hasPasswordField, isHttps, hasBrandLogoText, url: location.href }
  });
}
document.addEventListener("DOMContentLoaded", scanPage);
```

Signal worth flagging: **a password field on a non-HTTPS page**, or a page whose visible branding/text mentions a well-known brand while the domain doesn't match that brand at all.

The content script is also how you'd draw the actual **warning banner** once `background.js` decides a page is risky — inject a small fixed-position `<div>` via `chrome.scripting.executeScript` or by listening for a message from the background worker.

---

## §6. Scoring — combining everything

Keep it simple and explainable at first (not a black box):

```js
function computeRiskScore({ chainLength, crossDomainHops, hasHttpDowngrade,
                             lookalikeDistance, isPunycode, isCombosquat,
                             passwordOnHttp }) {
  let score = 0;
  if (chainLength >= 3) score += 20;
  if (crossDomainHops >= 2) score += 20;
  if (hasHttpDowngrade) score += 25;
  if (lookalikeDistance !== null && lookalikeDistance <= 2) score += 30;
  if (isPunycode) score += 15;
  if (isCombosquat) score += 30;
  if (passwordOnHttp) score += 25;
  return Math.min(score, 100);
}
```

Then bucket: `0–29 = low`, `30–59 = medium`, `60+ = high` — and **always store the individual reasons alongside the score** so the popup can explain "why" instead of just showing a number.

---

## §7. UI layer

- `chrome.action.setBadgeText({ tabId, text: "!" })` and `chrome.action.setBadgeBackgroundColor(...)` for at-a-glance risk level in the toolbar
- Popup (`popup/popup.js`) reads the current tab's stored score/reasons from `chrome.storage.session` and lists them
- Warning banner via content script for high-risk pages, with a dismiss button (respect the user's choice per-tab, don't nag)

---

## §8. Storage schema (suggested)

```js
// chrome.storage.local
{
  "allowlist": ["example.com", "internal-tool.mycompany.com"],
  "settings": { "sensitivity": "medium", "showBannerOnMedium": false },
}

// chrome.storage.session (per-session, cleared on browser restart)
{
  "tabRisk:123": { "score": 72, "reasons": ["combosquat", "chain_length_4"], "url": "..." }
}
```

---

## §9. Testing strategy

- **Don't test against real phishing sites.** Build a handful of tiny local HTML test pages (served via a simple local server or `file://`) that simulate: a multi-hop redirect chain, a punycode domain, a page with a password field over HTTP.
- Unit-test `domainAnalysis.js` in isolation (it's plain JS, no Chrome APIs) — this is the easiest part to get a fast feedback loop on.
- Use the service worker inspector console (`chrome://extensions` → your extension → "Inspect views: service worker") constantly during development.

---

## §10. Suggested learning order (checkpoint list)

1. [ ] Load an empty MV3 extension with no console errors
2. [ ] Log every `webNavigation.onCommitted` event with its `transitionQualifiers`
3. [ ] Assemble a redirect chain per tab using `webRequest.onBeforeRedirect`
4. [ ] Write and unit-test `levenshtein()` and `checkLookalike()` standalone (no browser needed)
5. [ ] Add punycode + combosquat checks
6. [ ] Wire domain analysis into the navigation listener, log a computed score
7. [ ] Add badge coloring based on score
8. [ ] Add the popup showing score + reasons
9. [ ] Add the content-script warning banner for high-risk pages
10. [ ] Add allowlist + sensitivity settings in an options page
11. [ ] Write your local test pages and validate each detection path fires correctly

---

## §11. Further reading

- Chrome for Developers: `chrome.webNavigation` API reference
- Chrome for Developers: `chrome.webRequest` API reference
- Chrome for Developers: Manifest V3 migration guide
- Public Suffix List (for correct eTLD+1 parsing later)
