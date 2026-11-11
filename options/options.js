// Aegis options page — reads/writes the storage schema described in
// REFERENCE.md §8:
//   chrome.storage.local: { settings: {...}, allowlist: [...] }

const DEFAULT_SETTINGS = { sensitivity: "medium", showBannerOnMedium: false, notifications: false, theme: "system" };

// ── Theme (system / light / dark) ───────────────────────────────────────
const prefersLight = window.matchMedia("(prefers-color-scheme: light)");
const themeSegmentedEl = document.getElementById("themeSegmented");

function effectiveTheme(preference) {
  if (preference === "light" || preference === "dark") return preference;
  return prefersLight.matches ? "light" : "dark";
}

function paintTheme(preference) {
  document.documentElement.dataset.theme = effectiveTheme(preference);
  [...themeSegmentedEl.children].forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.value === (preference || "system")));
  });
}

themeSegmentedEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented__opt");
  if (!btn) return;
  paintTheme(btn.dataset.value);
  saveSettingsPatch({ theme: btn.dataset.value });
});

prefersLight.addEventListener("change", async () => {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings?.theme || settings.theme === "system") paintTheme("system");
});

const segmentedEl = document.getElementById("sensitivitySegmented");
const showBannerEl = document.getElementById("showBannerOnMedium");
const notificationsEl = document.getElementById("notifications");
const allowlistForm = document.getElementById("allowlistForm");
const allowlistInput = document.getElementById("allowlistInput");
const allowlistListEl = document.getElementById("allowlistList");
const allowlistEmptyEl = document.getElementById("allowlistEmpty");
const savedNoteEl = document.getElementById("savedNote");

let savedNoteTimer = null;
function flashSaved() {
  savedNoteEl.hidden = false;
  clearTimeout(savedNoteTimer);
  savedNoteTimer = setTimeout(() => (savedNoteEl.hidden = true), 1400);
}

// ── Settings ─────────────────────────────────────────────────────────
async function loadSettings() {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  renderSettings(merged);
  paintTheme(merged.theme);
}

function renderSettings(settings) {
  [...segmentedEl.children].forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.value === settings.sensitivity));
  });
  showBannerEl.checked = !!settings.showBannerOnMedium;
  notificationsEl.checked = !!settings.notifications;
}

async function saveSettingsPatch(patch) {
  const { settings = DEFAULT_SETTINGS } = await chrome.storage.local.get("settings");
  const next = { ...DEFAULT_SETTINGS, ...settings, ...patch };
  await chrome.storage.local.set({ settings: next });
  renderSettings(next);
  flashSaved();
}

segmentedEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".segmented__opt");
  if (!btn) return;
  saveSettingsPatch({ sensitivity: btn.dataset.value });
});

showBannerEl.addEventListener("change", () => saveSettingsPatch({ showBannerOnMedium: showBannerEl.checked }));
notificationsEl.addEventListener("change", () => saveSettingsPatch({ notifications: notificationsEl.checked }));

// ── Allowlist ────────────────────────────────────────────────────────
function normalizeDomainInput(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return null;
  // Allow pasting a full URL — extract just the hostname.
  try {
    if (!/^https?:\/\//.test(value)) value = `https://${value}`;
    value = new URL(value).hostname;
  } catch {
    return null;
  }
  return value.replace(/^www\./, "") || null;
}

async function loadAllowlist() {
  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  renderAllowlist(allowlist);
}

function renderAllowlist(allowlist) {
  allowlistListEl.innerHTML = "";
  allowlistEmptyEl.hidden = allowlist.length > 0;

  for (const entry of allowlist) {
    const li = document.createElement("li");

    const label = document.createElement("span");
    label.textContent = entry;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => removeFromAllowlist(entry));

    li.appendChild(label);
    li.appendChild(removeBtn);
    allowlistListEl.appendChild(li);
  }
}

async function addToAllowlist(domain) {
  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  if (allowlist.includes(domain)) return;
  const next = [...allowlist, domain].sort();
  await chrome.storage.local.set({ allowlist: next });
  renderAllowlist(next);
  flashSaved();
}

async function removeFromAllowlist(domain) {
  const { allowlist = [] } = await chrome.storage.local.get("allowlist");
  const next = allowlist.filter((e) => e !== domain);
  await chrome.storage.local.set({ allowlist: next });
  renderAllowlist(next);
  flashSaved();
}

allowlistForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const domain = normalizeDomainInput(allowlistInput.value);
  if (!domain) {
    allowlistInput.focus();
    return;
  }
  addToAllowlist(domain);
  allowlistInput.value = "";
  allowlistInput.focus();
});

// Keep the UI in sync if storage changes elsewhere (e.g. "Trust this site" in the popup).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.allowlist) renderAllowlist(changes.allowlist.newValue || []);
  if (changes.settings) {
    const merged = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
    renderSettings(merged);
    paintTheme(merged.theme);
  }
});

loadSettings();
loadAllowlist();
