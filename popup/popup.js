// Aegis popup — reads the active tab's stored risk assessment from the
// background service worker and renders it. Does not compute anything
// itself; all scoring lives in background.js / lib/domainAnalysis.js so
// there's a single source of truth.

const LEVEL_COLOR_VAR = { low: "--low", medium: "--medium", high: "--high" };
const LEVEL_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" };

const contentEl = document.getElementById("content");
const settingsBtn = document.getElementById("settingsBtn");
const themeToggleBtn = document.getElementById("themeToggleBtn");

settingsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// ── Theme (system / light / dark) ───────────────────────────────────────
// "system" is stored as the preference, but the DOM always gets an explicit
// data-theme of "light" or "dark" so the CSS only has to branch two ways.
const prefersLight = window.matchMedia("(prefers-color-scheme: light)");

function effectiveTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return prefersLight.matches ? "light" : "dark";
}

function paintTheme(preference) {
  document.documentElement.dataset.theme = effectiveTheme(preference);
}

async function initTheme() {
  const { settings } = await chrome.storage.local.get("settings");
  paintTheme(settings?.theme || "system");

  // Keep in sync if the OS theme changes mid-session while on "system".
  prefersLight.addEventListener("change", async () => {
    const { settings: latest } = await chrome.storage.local.get("settings");
    if (!latest?.theme || latest.theme === "system") paintTheme("system");
  });
}

themeToggleBtn.addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  paintTheme(next);
  const { settings = {} } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...settings, theme: next } });
});

initTheme();

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderEmpty(text) {
  contentEl.innerHTML = `<div class="empty">${text}</div>`;
}

function gaugeMarkup(score, level) {
  const r = 36;
  const circumference = 2 * Math.PI * r;
  const color = cssVar(LEVEL_COLOR_VAR[level] || "--low");

  // Starts empty and animates to the real value after mount (see
  // animateGauge) so the ring sweeps in instead of popping in at full length.
  return `
    <div class="gauge">
      <svg width="84" height="84" viewBox="0 0 84 84">
        <circle class="gauge-track" cx="42" cy="42" r="${r}" />
        <circle class="gauge-fill" cx="42" cy="42" r="${r}"
          stroke="${color}"
          data-circumference="${circumference}"
          stroke-dasharray="0 ${circumference}" />
      </svg>
      <div class="gauge-value">
        <span class="gauge-value__score">${score}</span>
        <span class="gauge-value__max">/ 100</span>
      </div>
    </div>
  `;
}

function animateGauge(score) {
  const fill = contentEl.querySelector(".gauge-fill");
  if (!fill) return;
  const circumference = Number(fill.dataset.circumference);
  const target = (Math.max(0, Math.min(100, score)) / 100) * circumference;
  // Two frames so the empty state paints before the transition target is set.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      fill.setAttribute("stroke-dasharray", `${target} ${circumference}`);
    });
  });
}

function reasonsMarkup(riskData) {
  if (!riskData.reasons || riskData.reasons.length === 0) {
    return `<div class="clean-line">✓ No suspicious signals detected on this page</div>`;
  }

  const items = riskData.reasons.map((r) => `<li>${escapeHtml(r.text)}</li>`).join("");
  const brandHit = riskData.closestBrand
    ? `<div class="brand-hit">Closest brand match: <b>${escapeHtml(riskData.closestBrand.brand)}</b> (edit distance ${riskData.closestBrand.distance})</div>`
    : "";

  return `
    <div class="panel">
      <p class="panel__title">Why this score</p>
      <ul class="reason-list">${items}</ul>
      ${brandHit}
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

async function render(riskData, tabId) {
  if (!riskData) {
    renderEmpty("Aegis hasn't scanned this page yet. Try reloading the tab.");
    return;
  }

  const level = riskData.level || "low";
  const color = cssVar(LEVEL_COLOR_VAR[level] || "--low");
  const hostname = riskData.hostname || "(unknown host)";

  const allowlistedBanner = riskData.allowlisted
    ? `<div class="allowlisted-banner">✓ This site is on your trusted allowlist</div>`
    : "";

  contentEl.innerHTML = `
    ${allowlistedBanner}
    <div class="gauge-row">
      ${gaugeMarkup(riskData.score || 0, level)}
      <div class="gauge-summary">
        <span class="level-chip" style="color:${color}; background:color-mix(in srgb, ${color} 16%, transparent);">
          <span class="level-chip__dot"></span>${LEVEL_LABEL[level] || "Unknown"}
        </span>
        <div class="site-line" title="${escapeHtml(hostname)}">${escapeHtml(hostname)}</div>
        ${
          riskData.chainLength
            ? `<div class="site-sub">${riskData.chainLength} redirect hop${riskData.chainLength === 1 ? "" : "s"} before landing here</div>`
            : `<div class="site-sub">Direct navigation, no redirects</div>`
        }
      </div>
    </div>

    ${reasonsMarkup(riskData)}

    <div class="actions">
      <button id="trustBtn" class="btn ${riskData.allowlisted ? "btn--trusted" : ""}">
        ${riskData.allowlisted ? "✓ Trusted — click to remove" : "Trust this site"}
      </button>
    </div>
  `;

  document.getElementById("trustBtn").addEventListener("click", () => toggleAllowlist(riskData, tabId));
  animateGauge(riskData.score || 0);
}

async function toggleAllowlist(riskData, tabId) {
  const target = riskData.registrableDomain || riskData.hostname;
  if (!target) return;

  const trustBtn = document.getElementById("trustBtn");
  trustBtn.disabled = true;

  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  const lower = target.toLowerCase();
  const nextAllowlist = riskData.allowlisted
    ? allowlist.filter((e) => e.toLowerCase() !== lower)
    : [...new Set([...allowlist, lower])];

  await chrome.storage.local.set({ allowlist: nextAllowlist });

  const updated = await sendMessage({ type: "REFRESH_TAB", tabId });
  await render(updated, tabId);
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
    renderEmpty("Aegis only scans http(s) pages.");
    return;
  }

  const riskData = await sendMessage({ type: "GET_TAB_RISK", tabId: tab.id });
  await render(riskData, tab.id);
}

init();
