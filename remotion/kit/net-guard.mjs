// NETWORK DEFENCE (layer 3 of 4) for the page that runs an AI-written 3D scene. The macOS sandbox has to allow loopback (Remotion's file
// server and Chrome's DevTools socket live there), so a hostile scene could still reach 127.0.0.1 services (the app on :3000, the voice
// studio on :3900, Postgres, Redis) from page JavaScript. Two browser-side controls close that, both set BEFORE the page loads:
//   1. a Content-Security-Policy added to the main document's response (Fetch domain, response stage): connect-src / img-src / media-src /
//      font-src / script-src name ONLY the bundle server's own origin (+ data: and blob: for pictures); frames, workers, objects, forms and
//      <base> are 'none'. The browser itself then refuses fetch / XMLHttpRequest / WebSocket / EventSource / Image / frames to any other port.
//   2. a request filter (Fetch domain, request stage): every request whose origin is not the bundle server's (the origin of the first
//      main-frame document) is failed with BlockedByClient before it leaves the page, and logged as `GUARD blocked scheme://host:port`.
// Used only by --scene3d-code and --scene3d-code-stills (render-entry.mjs); the other render modes are untouched. Pure helpers are
// exported for unit tests; guardPage takes any page-like object with _client() (a CDPSession: send + on).

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The CSP that only lets the page talk to `origin` (the bundle server). */
export function cspFor(origin) {
  return [
    "default-src 'none'",
    `script-src ${origin} 'unsafe-inline'`, // the bundle's html has inline setup scripts; 'unsafe-eval' is NOT allowed
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data: blob:`,
    `media-src ${origin} data: blob:`,
    `font-src ${origin} data:`,
    `connect-src ${origin} data: blob:`,
    "worker-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "sandbox allow-scripts allow-same-origin", // no popups (a link with target=_blank), no forms, no top-level navigation: a popup would load BEFORE any guard can attach to it
  ].join("; ");
}

/** What the request filter does with one URL. `origin` is the bundle server's EXACT origin, passed in by render-entry (never learned from traffic). */
export function decide(url, origin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, why: "unparsable" };
  }
  if (typeof origin !== "string" || origin === "") return { allow: false, why: "no-origin" };
  if (u.protocol === "data:") return { allow: true };
  if (u.protocol === "about:") return { allow: u.href === "about:blank" || u.href === "about:srcdoc", why: "about" };
  if (u.protocol === "blob:") {
    let inner;
    try {
      inner = new URL(u.pathname);
    } catch {
      return { allow: false, why: "blob" };
    }
    return { allow: inner.origin === origin, why: "blob" };
  }
  if (u.protocol !== "http:") return { allow: false, why: u.protocol };
  return { allow: u.origin === origin, why: "origin" };
}

/** Run before any page script: no WebRTC, no WebTransport, no service workers, no extra windows (belt and braces behind the CSP and the checker). */
export const HARDEN_SCRIPT = `(() => { const names = ["indexedDB","caches","RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","RTCSessionDescription","RTCIceCandidate","WebTransport","WebSocket","EventSource","SharedWorker","Worker"]; for (const n of names) { try { Object.defineProperty(globalThis, n, { value: undefined, configurable: false, writable: false }); } catch (e) {} } const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(String(k)) ? m.get(String(k)) : null), setItem: (k, v) => { m.set(String(k), String(v)); }, removeItem: (k) => { m.delete(String(k)); }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; }; for (const n of ["localStorage", "sessionStorage"]) { try { Object.defineProperty(globalThis, n, { value: mem(), configurable: false, writable: false }); } catch (e) {} } try { Object.defineProperty(navigator, "storage", { value: undefined, configurable: false }); } catch (e) {} try { Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: false }); } catch (e) {} try { Object.defineProperty(window, "open", { value: () => null, configurable: false, writable: false }); } catch (e) {} })();`;

/** `scheme://host:port`, nothing of the path or query: safe to log. */
export const labelOf = (url) => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`.slice(0, 80);
  } catch {
    return "unparsable-url";
  }
};

/**
 * Installs both controls on one page (before it navigates). `stats.blocked` counts refused requests; `log` gets one line per refusal
 * (at most 50 lines per page). Returns the stats object.
 */
/**
 * @param {any} page
 * @param {{ origin?: string, log?: (line: string) => void, stats?: { blocked: number, violations?: number } }} [options]
 */
export async function guardPage(page, { origin, log = console.log, stats = { blocked: 0 } } = {}) {
  const client = page._client();
  let logged = 0;
  const refuse = async (requestId, url, why) => {
    stats.blocked++;
    if (logged++ < 50) log(`GUARD blocked ${labelOf(url)} (${why})`);
    await client.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => undefined);
  };
  client.on("Fetch.requestPaused", (e) => {
    void (async () => {
      const { requestId, request, resourceType } = e;
      const url = request?.url ?? "";
      const isResponse = e.responseStatusCode !== undefined || e.responseErrorReason !== undefined;
      if (isResponse) {
        // Response stage, main-frame documents only: add the CSP header (the filter below already let the request through).
        if (e.responseErrorReason !== undefined || e.responseStatusCode < 200 || e.responseStatusCode >= 300 || e.responseStatusCode === 204) {
          await client.send("Fetch.continueResponse", { requestId }).catch(() => undefined);
          return;
        }
        try {
          const { value } = await client.send("Fetch.getResponseBody", { requestId });
          const body = value.base64Encoded ? value.body : Buffer.from(value.body, "utf8").toString("base64");
          const headers = (e.responseHeaders ?? []).filter((h) => !["content-security-policy", "content-length", "content-encoding"].includes(String(h.name).toLowerCase()));
          headers.push({ name: "Content-Security-Policy", value: cspFor(origin) });
          await client.send("Fetch.fulfillRequest", { requestId, responseCode: e.responseStatusCode, responseHeaders: headers, body });
        } catch {
          await refuse(requestId, url, "csp-failed"); // no CSP, no page: fail closed
        }
        return;
      }
      const d = decide(url, origin);
      if (!d.allow) return refuse(requestId, url, resourceType === "Document" ? "document-not-bundle" : (d.why ?? "origin"));
      await client.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
    })();
  });
  await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HARDEN_SCRIPT }); // not swallowed: no hardening, no page
  await client.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => undefined);
  await client.send("Network.setBlockedURLs", { urls: ["ws://*", "wss://*", "stun:*", "turn:*", "webrtc:*"] }).catch(() => undefined);
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
  return stats;
}

/**
 * Makes every page this browser opens guarded before Remotion navigates it, and treats any target the PAGE creates (a popup, a worker, a
 * service worker, a shared worker, an extra tab with an opener) as a violation: it is closed at once and `onViolation` is called (the
 * render fails). `origin` is the exact bundle server origin. Returns the shared stats.
 */
/**
 * @param {any} browser
 * @param {{ origin?: string, onViolation?: (type: string) => void, log?: (line: string) => void, stats?: { blocked: number, violations?: number } }} [options]
 */
export function guardBrowser(browser, { origin, onViolation = () => undefined, ...opts } = {}) {
  const stats = opts.stats ?? { blocked: 0, violations: 0 };
  stats.violations ??= 0;
  const log = opts.log ?? console.log;
  const open = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await open(...args);
    await guardPage(page, { ...opts, origin, stats });
    return page;
  };
  browser.on?.("targetcreated", (target) => {
    let type = "other";
    let opener;
    try {
      type = target.type();
      opener = target.opener();
    } catch {
      /* treated as a violation below */
    }
    if (type === "browser" || (type === "page" && !opener)) return;
    stats.violations++;
    log(`GUARD violation: a ${type} target was created by the page`);
    Promise.resolve(browser.connection?.send?.("Target.closeTarget", { targetId: target._targetId })).catch(() => undefined);
    onViolation(type);
  });
  return stats;
}
