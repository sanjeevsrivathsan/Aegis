// Aegis background service worker
importScripts("lib/publicSuffixList.js", "lib/brandList.js", "lib/domainAnalysis.js");

// ── Per-tab redirect chains (in-memory; reset on new navigation) ──
const chains = new Map();

function appendToChain(tabId, hop) {
  if (!chains.has(tabId)) chains.set(tabId, []);
  chains.get(tabId).push(hop);
}

function recordRedirectHop(tabId, url) {
  const list = chains.get(tabId) || [];
  list.push({ from: url, to: null, statusCode: null, source: "webNavigation" });
  chains.set(tabId, list);
}

// ── Redirect chain analysis ──
function getHostnameSafe(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function analyzeRedirectChain(chain, finalUrl) {
  const hops = chain.filter((h) => h.from || h.to);
  const chainLength = hops.length;
  const domains = new Set();

  let hasHttpDowngrade = false;
  let prevProtocol = null;

  for (const hop of hops) {
    const fromUrl = hop.from;
    const toUrl = hop.to || hop.from;
    for (const u of [fromUrl, toUrl]) {
      if (!u) continue;
      try {
        const parsed = new URL(u);
        const reg = getRegistrableDomain(parsed.hostname);
        if (reg) domains.add(reg);

        if (prevProtocol === "https:" && parsed.protocol === "http:") {
          hasHttpDowngrade = true;
        }
        prevProtocol = parsed.protocol;
      } catch {
        /* skip malformed URLs */
      }
    }
  }

  const finalReg = getRegistrableDomain(getHostnameSafe(finalUrl));
  if (finalReg) domains.add(finalReg);

  const crossDomainHops = Math.max(0, domains.size - 1);

  return { chainLength, crossDomainHops, hasHttpDowngrade, domains: [...domains] };
}

// ── Risk scoring ──
function computeRiskScore({
  chainLength,
  crossDomainHops,
  hasHttpDowngrade,
  lookalikeDistance,
  isPunycodeDomain,
  isCombosquatDomain,
  passwordOnHttp,
  suspiciousTld,
  brandTitleMismatch = null,
  homographBrand = null,
  mixedScript = false,
  passwordField = false,
  sensitivity = "medium",
}) {
  let score = 0;
  const reasons = [];

  if (chainLength >= 3) {
    score += 20;
    reasons.push({ id: "chain_length", text: `Redirect chain has ${chainLength} hops`, weight: 20 });
  }
  if (crossDomainHops >= 2) {
    score += 20;
    reasons.push({
      id: "cross_domain",
      text: `Crossed ${crossDomainHops} unrelated domains in redirect chain`,
      weight: 20,
    });
  }
  if (hasHttpDowngrade) {
    score += 25;
    reasons.push({ id: "http_downgrade", text: "HTTPS downgraded to HTTP mid-chain", weight: 25 });
  }
  if (lookalikeDistance !== null && lookalikeDistance <= 2) {
    score += 30;
    reasons.push({
      id: "lookalike",
      text: `Domain closely resembles a known brand (edit distance ${lookalikeDistance})`,
      weight: 30,
    });
  }
  if (isPunycodeDomain) {
    score += 15;
    reasons.push({ id: "punycode", text: "Domain uses punycode/IDN (possible homograph attack)", weight: 15 });
  }
  if (isCombosquatDomain) {
    score += 30;
    reasons.push({
      id: "combosquat",
      text: "Brand name appears in subdomain of unrelated domain",
      weight: 30,
    });
  }
  if (passwordOnHttp) {
    score += 25;
    reasons.push({ id: "password_http", text: "Password field on non-HTTPS page", weight: 25 });
  }
  if (suspiciousTld) {
    score += 10;
    reasons.push({ id: "suspicious_tld", text: "Domain uses a commonly abused TLD", weight: 10 });
  }
  if (homographBrand) {
    score += 30;
    reasons.push({
      id: "homograph_brand",
      text: `Look-alike Unicode letters spell "${homographBrand}" (IDN homograph)`,
      weight: 30,
    });
  } else if (mixedScript) {
    score += 10;
    reasons.push({ id: "mixed_script", text: "Domain mixes Latin and Cyrillic/Greek letters", weight: 10 });
  }
  // A login form on a site that already looks like it imitates a brand is the
  // core phishing shape, whatever the page title says.
  const impersonates =
    (lookalikeDistance !== null && lookalikeDistance <= 2) || isCombosquatDomain || !!homographBrand;
  if (passwordField && impersonates) {
    score += 20;
    reasons.push({
      id: "login_on_lookalike",
      text: "Password form on a domain that imitates a known brand",
      weight: 20,
    });
  }
  if (brandTitleMismatch) {
    score += 15;
    reasons.push({
      id: "brand_title_mismatch",
      text: `Login page names "${brandTitleMismatch}" but the domain isn't ${brandTitleMismatch}'s`,
      weight: 15,
    });
  }

  const multiplier = sensitivity === "high" ? 1.2 : sensitivity === "low" ? 0.8 : 1;
  score = Math.min(Math.round(score * multiplier), 100);

  let level = "low";
  if (score >= 60) level = "high";
  else if (score >= 30) level = "medium";

  return { score, level, reasons };
}

function getRiskBucket(score) {
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

// ── Storage helpers ──
const DEFAULT_SETTINGS = {
  sensitivity: "medium",
  showBannerOnMedium: false,
  notifications: false,
  theme: "system",
};

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  // Merge over defaults so a partially-written settings object (e.g. only
  // `theme`, saved from the popup before first install defaults landed)
  // can't leave other fields undefined.
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function getAllowlist() {
  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  return allowlist;
}

function isAllowlisted(hostname, allowlist) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  const registrable = getRegistrableDomain(host);
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return host === e || host.endsWith("." + e) || registrable === e;
  });
}

async function storeTabRisk(tabId, riskData) {
  const key = `tabRisk:${tabId}`;
  await chrome.storage.session.set({ [key]: { ...riskData, tabId, updatedAt: Date.now() } });
}

async function getTabRisk(tabId) {
  const key = `tabRisk:${tabId}`;
  const result = await chrome.storage.session.get(key);
  return result[key] || null;
}

// ── UI updates ──
const BADGE_COLORS = { low: "#4CAF50", medium: "#FF9800", high: "#F44336" };

async function updateBadge(tabId, score, level) {
  const text = score > 0 ? String(score) : "";
  await chrome.action.setBadgeText({ tabId, text });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[level] || BADGE_COLORS.low });
}

async function notifyContentScript(tabId, payload) {
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    /* tab may not have content script yet */
  }
}

async function maybeNotify(risk, url) {
  const settings = await getSettings();
  if (!settings.notifications || risk.level !== "high") return;
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Aegis: High Risk Page",
    message: `Score ${risk.score}: ${risk.reasons[0]?.text || url}`,
  });
}

// ── Per-tab page signals from content script ──
const pageSignals = new Map();

// ── Main assessment ──
async function assessTab(tabId, url) {
  const hostname = getHostnameSafe(url);
  const allowlist = await getAllowlist();
  const settings = await getSettings();

  if (isAllowlisted(hostname, allowlist)) {
    const cleared = { score: 0, level: "low", reasons: [], url, allowlisted: true };
    await storeTabRisk(tabId, cleared);
    await updateBadge(tabId, 0, "low");
    await notifyContentScript(tabId, { type: "RISK_UPDATE", data: cleared });
    return cleared;
  }

  const chain = chains.get(tabId) || [];
  const chainAnalysis = analyzeRedirectChain(chain, url);
  const domainAnalysis = analyzeDomain(url, BRAND_LIST, SUSPICIOUS_TLDS, KNOWN_LEGIT_DOMAINS);
  const signals = pageSignals.get(tabId) || {};

  const risk = computeRiskScore({
    chainLength: chainAnalysis.chainLength,
    crossDomainHops: chainAnalysis.crossDomainHops,
    hasHttpDowngrade: chainAnalysis.hasHttpDowngrade,
    lookalikeDistance: domainAnalysis.closestBrand?.distance ?? null,
    isPunycodeDomain: domainAnalysis.isPunycode,
    isCombosquatDomain: domainAnalysis.isCombosquat,
    passwordOnHttp: signals.hasPasswordField && !signals.isHttps,
    suspiciousTld: domainAnalysis.suspiciousTld && domainAnalysis.closestBrand,
    homographBrand: domainAnalysis.homographBrand,
    mixedScript: domainAnalysis.mixedScript,
    passwordField: !!signals.hasPasswordField,
    // Brand-in-title is weak on its own, so it only counts on pages that
    // also ask for a password (the classic fake-login shape).
    brandTitleMismatch: signals.hasPasswordField
      ? findBrandInTitle(signals.title, domainAnalysis.registrableDomain, BRAND_LIST)
      : null,
    sensitivity: settings.sensitivity,
  });

  const riskData = {
    score: risk.score,
    level: risk.level,
    reasons: risk.reasons,
    url,
    hostname: domainAnalysis.hostname,
    registrableDomain: domainAnalysis.registrableDomain,
    closestBrand: domainAnalysis.closestBrand,
    chainLength: chainAnalysis.chainLength,
    chainDomains: chainAnalysis.domains,
    pageSignals: signals,
    allowlisted: false,
  };

  console.log("[Aegis] Assessment:", tabId, url, riskData);

  await storeTabRisk(tabId, riskData);
  await updateBadge(tabId, risk.score, risk.level);
  await maybeNotify(risk, url);

  const showBanner =
    risk.level === "high" || (risk.level === "medium" && settings.showBannerOnMedium);

  await notifyContentScript(tabId, {
    type: "RISK_UPDATE",
    data: { ...riskData, showBanner },
  });

  return riskData;
}

// ── §2 Navigation logging ──
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;

  console.log("[Aegis] Committed:", details.url, details.transitionQualifiers);

  const qualifiers = details.transitionQualifiers || [];
  const chainSoFar = chains.get(details.tabId) || [];

  // webRequest.onBeforeRedirect already records every server-side hop, so
  // only fall back to the webNavigation qualifier when it saw none (avoids
  // counting the same 302 twice). Client-side redirects (meta refresh / JS
  // location changes) never reach webRequest, so always record those.
  const seenByWebRequest = chainSoFar.some((h) => h.source === "webRequest");
  if (qualifiers.includes("client_redirect") || (qualifiers.includes("server_redirect") && !seenByWebRequest)) {
    recordRedirectHop(details.tabId, details.url);
  }

  assessTab(details.tabId, details.url);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  chains.set(details.tabId, []);
  // Signals from the previous page must not colour the next page's score.
  pageSignals.delete(details.tabId);
  console.log("[Aegis] New navigation:", details.tabId, details.url);
});

chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return;
  assessTab(details.tabId, details.url);
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  console.log("[Aegis] SPA navigation:", details.url);
  assessTab(details.tabId, details.url);
});

// ── §3 Redirect chain via webRequest ──
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.tabId < 0) return;
    appendToChain(details.tabId, {
      from: details.url,
      to: details.redirectUrl,
      statusCode: details.statusCode,
      source: "webRequest",
    });
    console.log("[Aegis] Redirect hop:", details.tabId, details.url, "→", details.redirectUrl);
  },
  // main_frame only: pages are full of subresource redirects (ad pixels,
  // trackers, images) that aren't navigation hops and would otherwise
  // inflate the chain and trigger false "long redirect chain" warnings.
  { urls: ["<all_urls>"], types: ["main_frame"] }
);

// Clean up when tab closes
chrome.tabs.onRemoved.addListener((tabId) => {
  chains.delete(tabId);
  pageSignals.delete(tabId);
  chrome.storage.session.remove([`tabRisk:${tabId}`, `dismissed:${tabId}`]);
});

// ── Messages from content script / popup ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id ?? message.tabId;

  if (message.type === "PAGE_SIGNALS" && tabId != null) {
    pageSignals.set(tabId, message.data);
    console.log("[Aegis] Page signals:", tabId, message.data);
    if (message.data.url) {
      assessTab(tabId, message.data.url).then(sendResponse);
      return true;
    }
  }

  if (message.type === "GET_TAB_RISK" && tabId != null) {
    getTabRisk(tabId).then(sendResponse);
    return true;
  }

  if (message.type === "GET_TAB_RISK_BY_ID") {
    getTabRisk(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === "REFRESH_TAB" && message.tabId != null) {
    chrome.tabs
      .get(message.tabId)
      .then((tab) => (tab?.url ? assessTab(message.tabId, tab.url) : getTabRisk(message.tabId)))
      .then(sendResponse)
      .catch(() => sendResponse(null));
    return true;
  }

  // A dismissal is remembered per tab *and per site*: it holds while the
  // tab stays on the same registrable domain, but a navigation to a
  // different domain gets a fresh warning (otherwise dismissing one banner
  // would silently mute every later page in that tab).
  if (message.type === "DISMISS_BANNER" && tabId != null) {
    const site = getRegistrableDomain(getHostnameSafe(sender.tab?.url));
    chrome.storage.session.set({ [`dismissed:${tabId}`]: site || true }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "IS_BANNER_DISMISSED" && tabId != null) {
    chrome.storage.session.get(`dismissed:${tabId}`).then((r) => {
      const stored = r[`dismissed:${tabId}`];
      const site = getRegistrableDomain(getHostnameSafe(sender.tab?.url));
      sendResponse({ dismissed: !!stored && (stored === true || stored === site) });
    });
    return true;
  }

  return false;
});

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(async () => {
  const { settings, allowlist } = await chrome.storage.local.get(["settings", "allowlist"]);
  // Fill in anything missing without clobbering existing user choices
  // (important on updates, where `settings` exists but predates new keys).
  await chrome.storage.local.set({
    settings: { ...DEFAULT_SETTINGS, ...(settings || {}) },
    allowlist: allowlist || [],
  });
  console.log("[Aegis] Extension installed / updated");
});

console.log("[Aegis] Service worker started");
