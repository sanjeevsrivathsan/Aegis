# Aegis — Real-Time Phishing & Lookalike Domain Detector

A Chrome extension (Manifest V3) that watches pages as they load and warns you about:

1. **Suspicious redirect chains** — a page silently bouncing you through several domains before landing somewhere unexpected
2. **Lookalike / typosquatted domains** — `paypa1.com`, `micros0ft-support.com`, `faceb00k.com`, `paypal.com.verify-account.xyz`, `sbi-netbanking-kyc.icu`
3. **Risky page signals** — password fields on non-HTTPS pages, login pages that name a brand the domain has nothing to do with, punycode/IDN homograph domains (Cyrillic/Greek letters that spell a brand)

It is a **defensive, local-only** tool: it observes and warns. It never blocks navigation, never modifies a page beyond showing a warning banner, and never sends browsing data anywhere (see `PRIVACY.md`).

> `REFERENCE.md` is the original phase-by-phase learning guide for how each piece was built. This README describes the project as it stands now.

---

## What you get

- **Toolbar badge** with the risk score, coloured by level
- **Warning banner** on high-risk pages (optionally medium too) with a "Why?" breakdown and Dismiss
- **Popup** with an animated score gauge, the reasons behind the score, and one-click "Trust this site"
- **Settings page**: detection sensitivity, banner/notification toggles, trusted-site allowlist
- **Light, dark, or system theme** (popup toggle + settings page), with smooth transitions and `prefers-reduced-motion` respected

## How scoring works

Every signal is explainable: the score is a sum of weighted reasons, and the reasons are shown to the user.

| Signal | Weight | Fires when |
|---|---|---|
| Lookalike domain | 30 | Registrable domain, or any hyphen-separated word of it, is a near-miss of a known brand. Tolerance scales with brand length (≤3 letters: exact only; 4–5: one edit and only with a digit; 6–9: one edit; 10+: two). Digit-for-letter swaps (`g00gle`, `faceb00k`) always count |
| Combosquat | 30 | A brand is a whole word of the hostname (`paypal.com.verify-account.xyz`), or, for brands of 6+ letters, appears inside a word (`paypalverify.com`), on a domain that isn't the brand's |
| Homograph of a brand | 30 | The punycode-decoded name, with look-alike Unicode letters mapped to Latin, spells a brand (`xn--pypal-4ve.com` → paypal) |
| Mixed scripts | 10 | Latin and Cyrillic/Greek letters are mixed in one label (only when it isn't already a brand homograph) |
| Login form on a look-alike | 20 | A password field is present on a domain that already scored as lookalike, combosquat or homograph. This is what lifts credential-harvesting pages to *high* so the banner shows |
| HTTPS → HTTP downgrade | 25 | Redirect chain drops from HTTPS to HTTP |
| Password field on HTTP | 25 | Page has a password input and isn't served over HTTPS |
| Long redirect chain | 20 | 3+ main-frame redirect hops |
| Cross-domain redirects | 20 | Chain crosses 2+ unrelated registrable domains |
| Punycode / IDN | 15 | Any hostname label starts with `xn--` |
| Brand in title, wrong domain | 15 | Page has a password field and its title names a known brand the domain isn't (weak alone, so it needs the password field) |
| Suspicious TLD | 10 | Abused TLD **and** a brand lookalike match (never scored alone) |

Sensitivity multiplies the total (low ×0.8, medium ×1, high ×1.2). Levels: **0–29 low, 30–59 medium, 60+ high**.

## Project structure

```
phishguard/
├── manifest.json
├── background.js            # service worker: navigation + redirect tracking, scoring, messaging
├── content-script.js        # DOM signals + animated warning banner
├── lib/
│   ├── domainAnalysis.js    # eTLD+1, Levenshtein, punycode decoder, homograph skeletons, combosquat, brand-in-title (pure JS, unit-tested)
│   ├── brandList.js         # known brands, suspicious TLDs, known-legitimate brand-owned domains
│   └── publicSuffixList.js  # simplified multi-label suffix list (co.uk, com.au, ...)
├── popup/                   # toolbar popup (HTML/CSS/JS)
├── options/                 # settings page (HTML/CSS/JS)
├── icons/                   # 16 / 48 / 128 px
├── test/
│   ├── domainAnalysis.test.js   # unit tests for lib/domainAnalysis.js
│   ├── background.test.js       # runs the real background.js against a fake chrome API
│   └── e2e.test.js              # loads the unpacked extension into real Chromium (needs Playwright)
├── test-server/             # local pages + redirect chain for manual testing
├── PRIVACY.md
└── REFERENCE.md             # original learning guide
```

## Run it

1. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select this folder.
2. Pin the extension. Open the service-worker console (**Inspect views: service worker**) to watch `[Aegis]` logs.
3. Start the test server and click through the pages:

```bash
npm run test:server        # http://localhost:5500/
```

| Page | What it exercises |
|---|---|
| `/clean.html` | Baseline, should score 0 |
| `/password-http.html` | Password field on plain HTTP |
| `/redirect/start` | 4-hop server-side redirect chain |
| `/brand-mismatch.html` | "PayPal" login page on a non-PayPal domain: brand-in-title + password field |
| `/late-login.html` | Login form injected 1.5 s after load (picked up by the content script's MutationObserver) |

Lookalike, combosquat and punycode detection need a real registrable domain, so they can't fire on `localhost`. Those paths are covered by the unit tests instead.

## Tests

```bash
npm test
```

- **`domainAnalysis.test.js`** — registrable-domain parsing, Levenshtein, length-aware lookalike tolerance, leetspeak, combosquat (including the false-positive guards for `firstbank.com`, `ubs.com`, `login.microsoftonline.com`), RFC 3492 punycode decoding, homograph/mixed-script detection, TLD and brand-in-title checks.
- **`background.test.js`** — loads the real `background.js` in a sandbox with a fake `chrome` API and fires events at it: redirect-hop counting (no double counting, main-frame only), stale-signal reset between pages, per-site banner dismissal, allowlist, install/update defaults, and scoring.

- **`e2e.test.js`** (`npm run test:e2e`, optional) — loads the unpacked extension into real Chromium via Playwright and drives it against the local test server: install defaults, scoring on each test page, an exact 4-hop redirect count, the banner round trip, dismissal, allowlist, and the options/popup pages. Setup: `npm i -D playwright && npx playwright install chromium`.

Don't test against live phishing sites; use the local pages and tests above.

## Known limitations

- **Heuristics only.** No blocklist feed or ML. Expect some false positives and false negatives; every warning shows its reasons so you can judge it.
- **Small brand list** (~45 brands, including common Indian banks and payment apps). Extend `lib/brandList.js` for the brands you care about. Brand-owned domains that merely contain a brand name (`microsoftonline.com`, `amazonaws.com`, `googleusercontent.com`…) live in `KNOWN_LEGIT_DOMAINS` and are never flagged.
- **Simplified public-suffix handling.** `publicSuffixList.js` covers common multi-label suffixes only; swap in the full [Public Suffix List](https://publicsuffix.org/list/) for precise eTLD+1 parsing.
- **Late login forms: 30 s window.** The content script scans at `document_end`, then watches DOM changes for 30 seconds and re-reports once if a password field appears. A form added after that, or inside a closed shadow root / cross-origin iframe, isn't seen.
- **In-memory redirect chains.** If Chrome suspends the service worker in the middle of a navigation, that navigation's chain is lost (storage-backed chains are a possible next step).
- **Homograph coverage is a curated map**, not the full Unicode confusables table: it covers the common Cyrillic and Greek look-alikes.
- **Brand-in-title is a weak signal** and deliberately requires a password field to avoid flagging ordinary pages that mention a brand.

## Before publishing to the Chrome Web Store

- [ ] Click through the test pages once in your own desktop Chrome (the e2e test covers real Chromium headless; a manual pass covers the real toolbar badge, popup and notifications)
- [ ] Host `PRIVACY.md` at a public URL and link it in the store listing
- [ ] Write the "single purpose" statement and justify `<all_urls>` host access (every page's URL must be inspected to detect lookalike domains and redirects)
- [ ] Prepare store assets: at least one 1280×800 screenshot and the 440×280 small promo tile
- [ ] Decide on a real brand list and add a way to update it (remote code/config is not allowed in MV3, so updates ship with the extension)

## License

MIT (adjust as you like).
"# Aegis" 
