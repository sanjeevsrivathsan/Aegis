// Aegis test server — zero dependencies, plain Node http.
//
// Serves a handful of local pages that exercise each detection path without
// ever touching a real (or fake-but-live) phishing site:
//
//   /                     index with links to everything below
//   /clean.html           plain page, should score 0
//   /password-http.html   login form served over plain HTTP (no TLS here)
//   /brand-mismatch.html  page text mentions a brand the domain has nothing to do with
//   /redirect/start       kicks off a 4-hop 302 redirect chain crossing domains-in-name
//                         (can't fake real cross-domain hosts on localhost, so hop
//                         hostnames are encoded in the path instead — see README note
//                         on the page itself)
//   /late-login.html      login form injected 1.5 s after load (MutationObserver path)
//   /redirect/final.html  where the chain lands
//
// Run: npm run test:server   (then open http://localhost:5500/ and load the
// unpacked extension so you can watch the service worker console react)

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT ? Number(process.env.PORT) : 5500;
const PAGES_DIR = path.join(__dirname, "pages");

const REDIRECT_CHAIN = ["/redirect/hop1", "/redirect/hop2", "/redirect/hop3", "/redirect/final.html"];

function send(res, status, contentType, body) {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, "text/plain", "Not found");
    send(res, 200, contentType, data);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // Redirect chain: each hop 302s to the next, so webRequest.onBeforeRedirect
  // fires once per hop and background.js's chain-length / cross-domain logic
  // has something real to assemble.
  const hopIndex = REDIRECT_CHAIN.indexOf(url);
  if (hopIndex !== -1 && hopIndex < REDIRECT_CHAIN.length - 1) {
    res.writeHead(302, { Location: REDIRECT_CHAIN[hopIndex + 1] });
    res.end();
    console.log(`[test-server] 302 ${url} -> ${REDIRECT_CHAIN[hopIndex + 1]}`);
    return;
  }

  if (url === "/redirect/start") {
    res.writeHead(302, { Location: REDIRECT_CHAIN[0] });
    res.end();
    console.log(`[test-server] 302 /redirect/start -> ${REDIRECT_CHAIN[0]}`);
    return;
  }

  if (url === "/" || url === "/index.html") {
    return serveFile(res, path.join(PAGES_DIR, "index.html"), "text/html");
  }
  if (url === "/clean.html") {
    return serveFile(res, path.join(PAGES_DIR, "clean.html"), "text/html");
  }
  if (url === "/password-http.html") {
    return serveFile(res, path.join(PAGES_DIR, "password-http.html"), "text/html");
  }
  if (url === "/brand-mismatch.html") {
    return serveFile(res, path.join(PAGES_DIR, "brand-mismatch.html"), "text/html");
  }
  if (url === "/late-login.html") {
    return serveFile(res, path.join(PAGES_DIR, "late-login.html"), "text/html");
  }
  if (url === "/redirect/final.html") {
    return serveFile(res, path.join(PAGES_DIR, "redirect-final.html"), "text/html");
  }

  send(res, 404, "text/plain", "Not found");
});

server.listen(PORT, () => {
  console.log(`[test-server] listening on http://localhost:${PORT}`);
  console.log(`[test-server] try:`);
  console.log(`  http://localhost:${PORT}/            (index)`);
  console.log(`  http://localhost:${PORT}/clean.html`);
  console.log(`  http://localhost:${PORT}/password-http.html`);
  console.log(`  http://localhost:${PORT}/brand-mismatch.html`);
  console.log(`  http://localhost:${PORT}/redirect/start   (4-hop redirect chain)`);
  console.log(`\nNote: this is plain HTTP on purpose, for the password-on-HTTP signal.`);
  console.log(`Domain-based checks (lookalike/punycode/combosquat) need a real domain,`);
  console.log(`so they are covered by the unit tests (npm test) instead.`);
});
