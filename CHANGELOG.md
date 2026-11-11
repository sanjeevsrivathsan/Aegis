# Changelog

## 0.3.0
Detection quality release, driven by the weaknesses found while evaluating 0.2.0.

- **Fixed:** `micros0ft-support.com` (typo + extra word) scored 0. Hyphen-separated words of the domain are now compared against brands.
- **Fewer false positives:** length-aware lookalike tolerance (`ubs.com` ≠ `ups`, `icicibank.com` ≠ `citibank`), whole-word combosquat matching for short brands (`firstbank.com` ≠ `irs`), and a `KNOWN_LEGIT_DOMAINS` list (`microsoftonline.com`, `amazonaws.com`, …). On the 43-site benign set, medium-or-higher false positives went 3 → 0.
- **New:** IDN homograph detection. Punycode is decoded (RFC 3492) and look-alike Cyrillic/Greek letters are mapped to Latin, so `xn--pypal-4ve.com` is recognised as paypal. Mixed-script labels add a smaller signal.
- **New:** `login_on_lookalike` (+20). A password field on a lookalike/combosquat/homograph domain lifts the page to *high*, so the banner shows for credential-harvesting pages.
- **New:** content script watches for login forms rendered after page load (30 s, MutationObserver).
- **New:** leetspeak normalisation (`g00gle`, `faceb00k`), and Indian brands (SBI, HDFC, ICICI, Axis, Kotak, Paytm, PhonePe, IRCTC, Flipkart, UIDAI, NPCI, Income Tax, Airtel).
- Tests: 24 → 40 unit tests, more service-worker checks, 2 new e2e checks for late-rendered forms.

## 0.2.0
Dark/light/system theme, smoother popup and options UI, allowlist, settings, e2e test.
