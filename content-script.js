// Aegis content script — DOM signals + warning banner

const BANNER_ID = "phishguard-warning-banner";
const BANNER_STYLE_ID = "phishguard-banner-style";
const TRANSITION_MS = 260;

// One-time stylesheet for what inline styles can't express (hover states,
// the slide/fade transition, the details accordion). Every rule is scoped to
// our own element ID so it can't leak into the host page's styling.
function ensureBannerStyles() {
  if (document.getElementById(BANNER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = BANNER_STYLE_ID;
  style.textContent = `
    #${BANNER_ID} {
      transform: translateY(-100%);
      opacity: 0;
      transition: transform ${TRANSITION_MS}ms cubic-bezier(0.4, 0, 0.2, 1),
        opacity ${TRANSITION_MS}ms ease;
    }
    #${BANNER_ID}.pg-visible { transform: translateY(0); opacity: 1; }
    #${BANNER_ID} .pg-btn {
      transition: background-color 150ms ease, transform 100ms ease;
    }
    #${BANNER_ID} .pg-btn:hover { background: rgba(255, 255, 255, 0.3); }
    #${BANNER_ID} .pg-btn:active { transform: scale(0.95); }
    #${BANNER_ID} .pg-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    #${BANNER_ID} .pg-details {
      max-height: 0;
      opacity: 0;
      margin-top: 0;
      overflow: hidden;
      transition: max-height 220ms ease, opacity 180ms ease, margin-top 220ms ease;
    }
    #${BANNER_ID} .pg-details.pg-open { max-height: 260px; opacity: 0.95; margin-top: 8px; }
    @media (prefers-reduced-motion: reduce) {
      #${BANNER_ID}, #${BANNER_ID} .pg-btn, #${BANNER_ID} .pg-details { transition: none !important; }
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

let lateScanObserver = null;

// Single-page apps often render the login form after load. If the first scan
// found no password field, watch for one for up to 30 seconds and re-send the
// signals once if it appears.
function watchForLateLoginForm() {
  if (lateScanObserver || !document.documentElement) return;
  let timer = null;
  const stop = () => {
    if (lateScanObserver) lateScanObserver.disconnect();
    lateScanObserver = null;
    clearTimeout(timer);
  };
  lateScanObserver = new MutationObserver(() => {
    if (document.querySelector('input[type="password"]')) {
      stop();
      scanPage({ late: true });
    }
  });
  lateScanObserver.observe(document.documentElement, { childList: true, subtree: true });
  timer = setTimeout(stop, 30000);
}

function scanPage(opts = {}) {
  const hasPasswordField = !!document.querySelector('input[type="password"]');
  const isHttps = location.protocol === "https:";
  const hasBrandLogoText = /paypal|microsoft|apple|bank|amazon|google|netflix/i.test(document.title);

  if (!hasPasswordField && !opts.late) watchForLateLoginForm();

  const message = {
    type: "PAGE_SIGNALS",
    data: {
      hasPasswordField,
      isHttps,
      hasBrandLogoText,
      // Raw title lets background.js match against the shared BRAND_LIST
      // instead of this file's separate hard-coded regex.
      title: document.title,
      url: location.href,
    },
  };
  try {
    Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
  } catch {
    /* orphaned content script after an extension reload: nothing to report to */
  }
}

function createBanner(riskData) {
  removeBanner({ immediate: true });
  ensureBannerStyles();

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "alert");

  const level = riskData.level || "medium";
  const colors = {
    high: { bg: "#B71C1C", border: "#FF5252" },
    medium: { bg: "#E65100", border: "#FF9800" },
    low: { bg: "#1B5E20", border: "#4CAF50" },
  };
  const c = colors[level] || colors.medium;

  Object.assign(banner.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "2147483647",
    background: c.bg,
    color: "#fff",
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
    fontSize: "14px",
    padding: "12px 16px",
    boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
    borderBottom: `3px solid ${c.border}`,
    display: "flex",
    alignItems: "flex-start",
    gap: "12px",
  });

  const icon = document.createElement("span");
  icon.textContent = "⚠";
  icon.style.fontSize = "20px";
  icon.style.lineHeight = "1";

  const body = document.createElement("div");
  body.style.flex = "1";

  const title = document.createElement("strong");
  title.textContent = `Aegis: ${level.toUpperCase()} risk (score ${riskData.score})`;
  title.style.display = "block";
  title.style.marginBottom = "4px";

  const summary = document.createElement("span");
  summary.style.display = "block"; // keep the action buttons on their own row
  summary.textContent =
    riskData.reasons?.map((r) => r.text).join(" · ") || "Suspicious page detected";

  const detailsBtn = document.createElement("button");
  detailsBtn.textContent = "Why?";
  detailsBtn.className = "pg-btn";
  Object.assign(detailsBtn.style, {
    background: "rgba(255,255,255,0.2)",
    border: "1px solid rgba(255,255,255,0.4)",
    color: "#fff",
    padding: "4px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
    marginTop: "8px",
    marginRight: "8px",
  });

  const detailsPanel = document.createElement("div");
  detailsPanel.className = "pg-details";
  detailsPanel.style.fontSize = "12px";

  if (riskData.reasons?.length) {
    const ul = document.createElement("ul");
    ul.style.margin = "4px 0 0 16px";
    ul.style.padding = "0";
    for (const r of riskData.reasons) {
      const li = document.createElement("li");
      li.textContent = r.text;
      ul.appendChild(li);
    }
    detailsPanel.appendChild(ul);
  }
  if (riskData.hostname) {
    const p = document.createElement("p");
    p.style.margin = "4px 0 0";
    p.textContent = `Domain: ${riskData.hostname}`;
    detailsPanel.appendChild(p);
  }
  if (riskData.closestBrand) {
    const p = document.createElement("p");
    p.style.margin = "4px 0 0";
    p.textContent = `Closest brand match: ${riskData.closestBrand.brand} (distance ${riskData.closestBrand.distance})`;
    detailsPanel.appendChild(p);
  }

  detailsBtn.addEventListener("click", () => {
    detailsPanel.classList.toggle("pg-open");
  });

  const dismissBtn = document.createElement("button");
  dismissBtn.textContent = "Dismiss";
  dismissBtn.className = "pg-btn";
  Object.assign(dismissBtn.style, {
    background: "transparent",
    border: "1px solid rgba(255,255,255,0.5)",
    color: "#fff",
    padding: "4px 10px",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: "12px",
    marginTop: "8px",
  });
  dismissBtn.addEventListener("click", () => {
    // Remove first, persist second: after the extension is reloaded or
    // updated, content scripts already on open tabs are orphaned and any
    // chrome.runtime call throws "Extension context invalidated". The user's
    // click must still work in that case.
    removeBanner();
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: "DISMISS_BANNER" })).catch(() => {});
    } catch {
      /* orphaned content script: nothing to persist */
    }
  });

  body.appendChild(title);
  body.appendChild(summary);
  body.appendChild(detailsBtn);
  body.appendChild(dismissBtn);
  body.appendChild(detailsPanel);

  banner.appendChild(icon);
  banner.appendChild(body);

  document.documentElement.appendChild(banner);

  // Double rAF: let the initial (translated + transparent) state paint
  // before adding the class that transitions it in, or the browser may
  // collapse the two states into one frame and skip the animation.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => banner.classList.add("pg-visible"));
  });
}

function removeBanner({ immediate = false } = {}) {
  const existing = document.getElementById(BANNER_ID);
  if (!existing) return;

  if (immediate) {
    existing.remove();
    return;
  }

  existing.classList.remove("pg-visible");
  setTimeout(() => existing.remove(), TRANSITION_MS);
}

async function handleRiskUpdate(data) {
  if (data.allowlisted || data.score === 0) {
    removeBanner();
    return;
  }

  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: "IS_BANNER_DISMISSED" });
  } catch {
    /* background unreachable or context invalidated: treat as not dismissed */
  }
  if (reply?.dismissed) return;

  if (data.showBanner || data.level === "high") {
    createBanner(data);
  } else if (data.level === "low") {
    removeBanner();
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "RISK_UPDATE") {
    handleRiskUpdate(message.data);
  }
});

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", scanPage);
} else {
  scanPage();
}
