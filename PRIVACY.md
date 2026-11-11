# Aegis Privacy Policy

_Last updated: 2026-11-04_

Aegis analyzes the pages you visit **entirely on your device**. It does not collect, transmit, sell, or share any personal data or browsing history, and it makes no network requests of its own.

## What Aegis looks at

To detect phishing signals, Aegis reads, locally and in memory:

- The URL and domain of each page you open, and the redirect chain that led to it
- Whether the page has a password field, whether it is served over HTTPS, and the page title

This information is used only to compute a risk score shown to you in the toolbar badge, popup, and an on-page warning banner.

## What is stored, and where

| Data | Where | Lifetime |
|---|---|---|
| Your settings (sensitivity, banner/notification toggles, theme) | `chrome.storage.local` on your device | Until you uninstall the extension |
| Your trusted-site allowlist | `chrome.storage.local` on your device | Until you remove entries or uninstall |
| Per-tab risk results and banner-dismissal state | `chrome.storage.session` (memory) | Cleared when the browser closes or the tab is closed |

Aegis does not keep a browsing history, and nothing it stores leaves your device.

## Permissions

- **`webNavigation`, `webRequest`** (read-only): observe navigations and redirects to build the redirect chain. Aegis does not block or modify requests.
- **Access to all sites (`<all_urls>`)**: required to inspect every page's domain and to show the warning banner. Used only for the local analysis described above.
- **`storage`**: save your settings and allowlist.
- **`notifications`**: optional desktop notification for high-risk pages, only if you enable it.

## Changes

If this policy changes, the updated version will accompany the extension release that changes it.

## Contact

Questions? Open an issue on the project's repository.
