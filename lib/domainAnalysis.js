// Aegis — domain analysis (lib/domainAnalysis.js)
//
// Pure string/URL logic, no Chrome APIs — this is deliberate (see
// REFERENCE.md §4) so it can be unit-tested standalone in Node via
// test/domainAnalysis.test.js, and loaded into the service worker via
// importScripts() with zero changes.

(function () {
  const isServiceWorker = typeof self !== "undefined" && typeof importScripts === "function";
  const isNode = typeof module !== "undefined" && !!module.exports;

  const MULTI_LABEL_SUFFIXES = isServiceWorker
    ? self.MULTI_LABEL_SUFFIXES
    : isNode
    ? require("./publicSuffixList.js").MULTI_LABEL_SUFFIXES
    : new Set();

  // ── §4.1 eTLD+1 / registrable domain ─────────────────────────────────
  function getRegistrableDomain(hostname) {
    if (!hostname) return null;
    const host = hostname.toLowerCase().replace(/\.$/, "");
    const labels = host.split(".");
    if (labels.length < 2) return host; // "localhost", bare IPs, etc.

    const lastTwoLabels = labels.slice(-2).join(".");
    if (labels.length >= 3 && MULTI_LABEL_SUFFIXES && MULTI_LABEL_SUFFIXES.has(lastTwoLabels)) {
      return labels.slice(-3).join(".");
    }
    return lastTwoLabels;
  }

  function registrableCore(registrableDomain) {
    return registrableDomain ? registrableDomain.split(".")[0] : "";
  }

  // ── §4.2 punycode / IDN homograph check ──────────────────────────────
  function isPunycode(hostname) {
    if (!hostname) return false;
    return hostname.split(".").some((label) => label.startsWith("xn--"));
  }

  // ── §4.3 Levenshtein distance + lookalike check ──────────────────────
  function levenshtein(a, b) {
    a = a || "";
    b = b || "";
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] =
          a[i - 1] === b[j - 1]
            ? dp[i - 1][j - 1]
            : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  // Length-aware tolerance. Edit distance is noisy on short names (ubs is one
  // edit from ups; phase is one edit from chase), so:
  //   * 3 letters or fewer: exact matches only (handled as tokens elsewhere)
  //   * 4-5 letters: one edit, but only when the candidate contains a digit
  //     (the leetspeak substitution pattern: app1e, st3am)
  //   * 6-9 letters: one edit
  //   * 10+ letters: two edits
  function maxDistanceFor(brand, candidate) {
    const n = brand.length;
    if (n <= 3) return 0;
    if (n <= 5) return /\d/.test(candidate) ? 1 : 0;
    if (n <= 9) return 1;
    return 2;
  }

  // Digit-for-letter swaps (g00gle, faceb00k, paypa1). When undoing them spells
  // the brand exactly, the edit budget does not matter: the digits are the tell.
  const LEET = { "0": ["o"], "1": ["l", "i"], "3": ["e"], "4": ["a"], "5": ["s"], "7": ["t"] };
  function leetVariants(word) {
    if (!/\d/.test(word)) return [];
    let out = [""];
    for (const ch of word) {
      const subs = LEET[ch] || [ch];
      out = out.flatMap((prefix) => subs.map((c) => prefix + c));
      if (out.length > 16) break;
    }
    return out;
  }

  function isKnownLegit(registrableDomain, knownLegit) {
    return !!registrableDomain && !!knownLegit && knownLegit.includes(registrableDomain);
  }

  // Hostname tokens, excluding the public suffix (so the TLD of onlinesbi.sbi
  // is not mistaken for the brand "sbi"). Split on dots and hyphens.
  function hostTokens(hostname, registrableDomain) {
    if (!hostname) return [];
    let host = hostname.toLowerCase().replace(/\.$/, "");
    if (registrableDomain && host.endsWith(registrableDomain)) {
      const suffixLabels = registrableDomain.split(".").length - 1;
      const labels = host.split(".");
      host = labels.slice(0, labels.length - suffixLabels).join(".");
    }
    return host.split(/[^a-z0-9]+/).filter(Boolean);
  }

  // Compares the core label of the registrable domain (e.g. "paypa1" out of
  // "paypa1.com") against each brand, and also each hyphen-separated word of
  // it ("micros0ft" out of "micros0ft-support.com"). Distance 0 (exact match)
  // is excluded on purpose: that's the brand's own name, not a lookalike.
  function checkLookalike(registrableDomain, brandList, knownLegit) {
    const core = registrableCore(registrableDomain);
    if (!core || !brandList || !brandList.length) return [];
    if (isKnownLegit(registrableDomain, knownLegit)) return [];
    const candidates = new Set([core, ...core.split("-").filter((t) => t.length >= 4)]);
    const hits = new Map();
    for (const cand of candidates) {
      for (const brand of brandList) {
        if (cand === brand) continue;
        if (Math.abs(cand.length - brand.length) > 2) continue;
        const raw = levenshtein(cand, brand);
        const leetHit = raw > 0 && brand.length >= 4 && leetVariants(cand).includes(brand);
        const distance = raw;
        if (distance > 0 && (distance <= maxDistanceFor(brand, cand) || leetHit)) {
          const prev = hits.get(brand);
          if (!prev || distance < prev.distance) hits.set(brand, { brand, distance });
        }
      }
    }
    return [...hits.values()].sort((a, b) => a.distance - b.distance);
  }

  // ── §4.4 combosquatting: a brand name inside an unrelated domain ──────────
  // A brand counts when it is a whole word of the hostname (paypal in
  // paypal.com.verify-account.xyz, wellsfargo in wellsfargo-secure.click) or,
  // for brands of 6+ letters, appears inside a word (paypalverify.com). Short
  // brands never match inside words: "irs" would otherwise fire on firstbank.
  function isCombosquat(hostname, registrableDomain, brandList, knownLegit) {
    if (!hostname || !brandList || !brandList.length) return false;
    if (isKnownLegit(registrableDomain, knownLegit)) return false;
    const core = registrableCore(registrableDomain);
    const tokens = hostTokens(hostname, registrableDomain);
    return brandList.some((brand) => {
      if (core === brand) return false;
      if (tokens.includes(brand)) return true;
      return brand.length >= 6 && tokens.some((t) => t.includes(brand));
    });
  }

  // ── §4.5 IDN homographs: decode Punycode, map look-alike letters ─────────
  // Punycode decoder per RFC 3492 (section 6.2).
  function decodePunycode(input) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    let n = 128, i = 0, bias = 72;
    const output = [];
    let basic = input.lastIndexOf("-");
    if (basic < 0) basic = 0;
    for (let j = 0; j < basic; j++) output.push(input.charCodeAt(j));
    for (let idx = basic > 0 ? basic + 1 : 0; idx < input.length; ) {
      const oldi = i;
      let w = 1;
      for (let k = base; ; k += base) {
        if (idx >= input.length) return null; // malformed
        const c = input.charCodeAt(idx++);
        const digit = c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base;
        if (digit >= base) return null;
        i += digit * w;
        const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
        if (digit < t) break;
        w *= base - t;
      }
      const len = output.length + 1;
      let delta = i - oldi;
      delta = oldi === 0 ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / len);
      let k = 0;
      while (delta > ((base - tMin) * tMax) >> 1) {
        delta = Math.floor(delta / (base - tMin));
        k += base;
      }
      bias = k + Math.floor(((base - tMin + 1) * delta) / (delta + skew));
      n += Math.floor(i / len);
      i %= len;
      output.splice(i++, 0, n);
    }
    try {
      return String.fromCodePoint(...output);
    } catch {
      return null;
    }
  }

  // Small confusables table (a deliberately short subset of Unicode UTS #39).
  const CONFUSABLES = {
    "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y", "і": "i", "ј": "j",
    "ѕ": "s", "ԁ": "d", "һ": "h", "ӏ": "l", "ԛ": "q", "ԝ": "w", "ո": "n", "ɡ": "g", "ᴠ": "v",
    "α": "a", "ο": "o", "ρ": "p", "ν": "v", "ι": "i", "ε": "e", "τ": "t", "κ": "k", "υ": "u",
  };

  function scriptOf(ch) {
    if (/[a-z0-9-]/i.test(ch)) return "latin";
    if (/[\u0400-\u04FF]/.test(ch)) return "cyrillic";
    if (/[\u0370-\u03FF]/.test(ch)) return "greek";
    return "other";
  }

  // Looks at every xn-- label of a hostname. Returns
  //   { decoded, mixedScript, skeleton, brand }
  // where brand is a listed brand the decoded label imitates (identical after
  // mapping look-alike letters to Latin) or null, and mixedScript is true when
  // the label mixes Latin letters with Cyrillic or Greek ones.
  function checkHomograph(hostname, brandList) {
    const result = { decoded: null, mixedScript: false, skeleton: null, brand: null };
    if (!hostname) return result;
    for (const label of hostname.split(".")) {
      if (!label.startsWith("xn--")) continue;
      const decoded = decodePunycode(label.slice(4));
      if (!decoded) continue;
      const scripts = new Set([...decoded].map(scriptOf));
      const mixedScript = scripts.has("latin") && (scripts.has("cyrillic") || scripts.has("greek"));
      const skeleton = [...decoded.toLowerCase()].map((c) => CONFUSABLES[c] || c).join("");
      const brand = (brandList || []).find((b) => skeleton === b) || null;
      if (!result.decoded) Object.assign(result, { decoded, skeleton });
      if (mixedScript || brand) return { decoded, mixedScript, skeleton, brand };
    }
    return result;
  }

  // ── §4.4 suspicious TLD (only meaningful paired with a brand match) ──────
  function hasSuspiciousTld(registrableDomain, suspiciousTlds) {
    if (!registrableDomain || !suspiciousTlds || !suspiciousTlds.length) return false;
    return suspiciousTlds.some((tld) => registrableDomain.endsWith(tld));
  }

  // ── §5 brand named in the page title, but not in the domain ──────────────
  // Returns the first brand that appears as a whole word in the page title
  // while the registrable domain's own label isn't that brand (e.g. a
  // "PayPal - Log in" page served from secure-check.xyz). Whole-word matching
  // keeps short brands like "ups" from matching inside "groups". On its own
  // this is weak evidence (plenty of pages legitimately mention brands), so
  // background.js only scores it when the page also has a password field.
  function findBrandInTitle(title, registrableDomain, brandList) {
    if (!title || !registrableDomain || !brandList || !brandList.length) return null;
    const core = registrableCore(registrableDomain);
    const lowerTitle = title.toLowerCase();
    for (const brand of brandList) {
      if (core === brand) continue;
      const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(lowerTitle)) return brand;
    }
    return null;
  }

  // ── top-level entry point used by background.js ──────────────────────
  function analyzeDomain(url, brandList, suspiciousTlds, knownLegit) {
    let hostname = null;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      hostname = null;
    }

    const registrableDomain = getRegistrableDomain(hostname);
    const lookalikes = checkLookalike(registrableDomain, brandList || [], knownLegit);
    const homograph = checkHomograph(hostname, brandList || []);

    return {
      hostname,
      registrableDomain,
      isPunycode: isPunycode(hostname),
      isCombosquat: isCombosquat(hostname, registrableDomain, brandList || [], knownLegit),
      closestBrand: lookalikes[0] || null,
      suspiciousTld: hasSuspiciousTld(registrableDomain, suspiciousTlds || []),
      decodedHostname: homograph.decoded,
      mixedScript: homograph.mixedScript,
      homographBrand: homograph.brand,
    };
  }

  const api = {
    getRegistrableDomain,
    isPunycode,
    levenshtein,
    checkLookalike,
    isCombosquat,
    decodePunycode,
    checkHomograph,
    hostTokens,
    hasSuspiciousTld,
    findBrandInTitle,
    analyzeDomain,
  };

  if (isServiceWorker) {
    // importScripts() runs in the worker's own global scope, so attaching to
    // `self` makes these callable as bare identifiers from background.js —
    // matching how it already calls getRegistrableDomain()/analyzeDomain().
    Object.assign(self, api);
  }
  if (isNode) {
    module.exports = api;
  }
})();
