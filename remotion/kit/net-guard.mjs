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
  ].join("; ");
}

/** What the request filter does with one URL. `origin` is the bundle server's origin, or null before the first document is seen. */
export function decide(url, origin, resourceType) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { allow: false, why: "unparsable" };
  }
  if (u.protocol === "data:") return { allow: true };
  if (u.protocol === "about:") return { allow: u.href === "about:blank" || u.href === "about:srcdoc", why: "about" };
  if (u.protocol === "blob:") {
    let inner;
    try {
      inner = new URL(u.pathname);
    } catch {
      return { allow: false, why: "blob" };
    }
    return { allow: origin !== null && inner.origin === origin, why: "blob" };
  }
  if (u.protocol !== "http:") return { allow: false, why: u.protocol };
  if (origin === null) {
    // The very first main-frame document of the page is Remotion's own bundle server on this machine; it fixes the allowed origin.
    return LOCAL_HOSTS.has(u.hostname) && resourceType === "Document" ? { allow: true, learn: u.origin } : { allow: false, why: "before-document" };
  }
  return { allow: u.origin === origin, why: "origin" };
}

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
export async function guardPage(page, { log = console.log, stats = { blocked: 0 } } = {}) {
  const client = page._client();
  let origin = null;
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
        if (e.responseErrorReason !== undefined || origin === null || e.responseStatusCode < 200 || e.responseStatusCode >= 300 || e.responseStatusCode === 204) {
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
      const d = decide(url, origin, resourceType);
      if (!d.allow) return refuse(requestId, url, d.why ?? "origin");
      if (d.learn) origin = d.learn;
      await client.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
    })();
  });
  await client.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", resourceType: "Document", requestStage: "Response" }] });
  return stats;
}

/** Makes every page this browser opens guarded before Remotion navigates it. Returns the shared stats. */
export function guardBrowser(browser, opts = {}) {
  const stats = opts.stats ?? { blocked: 0 };
  const open = browser.newPage.bind(browser);
  browser.newPage = async (...args) => {
    const page = await open(...args);
    await guardPage(page, { ...opts, stats });
    return page;
  };
  return stats;
}
