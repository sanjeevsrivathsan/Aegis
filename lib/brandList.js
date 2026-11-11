// Aegis — known-brand and suspicious-TLD lists
//
// Starter set of frequently-impersonated brands (per REFERENCE.md §4.3) and
// TLDs that show up disproportionately often in phishing campaigns. Both are
// plain arrays on purpose — tune them as you see what you're actually
// flagging (false positives *and* false negatives) rather than trying to be
// exhaustive up front.

const BRAND_LIST = [
  "paypal", "microsoft", "apple", "google", "amazon", "netflix",
  "facebook", "instagram", "whatsapp", "chase", "wellsfargo",
  "bankofamerica", "americanexpress", "citibank", "capitalone",
  "coinbase", "binance", "docusign", "dropbox", "adobe", "linkedin",
  "outlook", "office365", "steam", "ebay", "walmart", "target",
  "usps", "fedex", "ups", "dhl", "irs", "hmrc",
  // India-focused additions (banks, payments, government, rail/retail)
  "sbi", "hdfcbank","hdfc","icici", "icicibank", "axisbank", "kotak", "paytm",
  "phonepe", "irctc", "flipkart", "uidai", "npci", "incometax", "airtel",
];

// Registrable domains that legitimately embed a brand name or sit one edit
// away from one. They are never reported as lookalikes/combosquats. Keep this
// list short and obviously real; users can extend it with the allowlist.
const KNOWN_LEGIT_DOMAINS = [
  "microsoftonline.com", "microsoftonline-p.com", "amazonaws.com", "amazonpay.in",
  "googleusercontent.com", "googleapis.com", "googlevideo.com", "googlesyndication.com",
  "googletagmanager.com", "google-analytics.com", "paypalobjects.com", "cdninstagram.com",
  "facebook.net", "whatsapp.net", "ebaystatic.com", "dropboxusercontent.com",
  "docusign.net", "paypay.com",
];

// TLDs that are cheap/free or otherwise heavily abused in typosquatting and
// combosquatting campaigns. This is a soft signal, never used alone — see
// computeRiskScore() in background.js, where it only adds weight when paired
// with a brand-name match.
const SUSPICIOUS_TLDS = [
  ".tk", ".ml", ".ga", ".cf", ".gq",
  ".xyz", ".top", ".click", ".link", ".work",
  ".loan", ".men", ".date", ".review", ".zip", ".rest", ".icu",
];

if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.BRAND_LIST = BRAND_LIST;
  self.SUSPICIOUS_TLDS = SUSPICIOUS_TLDS;
  self.KNOWN_LEGIT_DOMAINS = KNOWN_LEGIT_DOMAINS;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { BRAND_LIST, SUSPICIOUS_TLDS, KNOWN_LEGIT_DOMAINS };
}
