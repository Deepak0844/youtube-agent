import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { cspFor, decide, guardBrowser, guardPage, HARDEN_SCRIPT, labelOf } from "../../remotion/kit/net-guard.mjs";

// The loopback-only filter of the page that runs an AI-written scene (layer 3 of 4). Pure helpers plus a fake DevTools session: no Chrome.
const ORIGIN = "http://localhost:4123";

describe("decide", () => {
  const d = (url: string, origin: string | null = ORIGIN) => decide(url, origin as string).allow;
  it("lets through only the bundle server's own origin, data: and blob: of that origin, and about:blank", () => {
    for (const ok of [`${ORIGIN}/index.html`, `${ORIGIN}/bundle.js?x=1`, `${ORIGIN}/public/models/pp_ship.glb`, "data:image/png;base64,AAAA", `blob:${ORIGIN}/6f0f`, "about:blank"]) expect(d(ok), ok).toBe(true);
  });
  it("blocks every other loopback port (the app, the voice studio, Postgres, Redis), other hosts, other schemes", () => {
    for (const bad of [
      "http://127.0.0.1:3000/api/secret", "http://localhost:3900/v1/voices", "http://localhost:5432/", "http://127.0.0.1:6379/", "http://[::1]:4123/", "http://127.0.0.1:4123/x", // same port, other host name: a different origin
      "https://example.com/x", "http://169.254.169.254/latest/meta-data", "http://192.168.1.1/", "ws://127.0.0.1:3000/socket", "wss://localhost:4123/", "ftp://localhost/x", "file:///etc/passwd",
      "javascript:alert(1)", "chrome://version", "about:srcdoc2", "blob:http://127.0.0.1:3000/abc", "blob:null/abc", "blob:not a url", "not a url at all",
    ]) expect(d(bad), bad).toBe(false);
  });
  it("needs the EXPLICIT bundle origin: with none, or a different one, nothing is allowed (no learning from traffic)", () => {
    expect(d(`${ORIGIN}/index.html`, null)).toBe(false);
    expect(d(`${ORIGIN}/index.html`, "")).toBe(false);
    expect(d("http://127.0.0.1:4123/", ORIGIN)).toBe(false);
    expect(d("http://localhost:4124/index.html", ORIGIN)).toBe(false);
  });
  it("labels a refusal without the path or the query", () => {
    expect(labelOf("http://127.0.0.1:3000/api/key?token=SECRET")).toBe("http://127.0.0.1:3000");
    expect(labelOf("garbage")).toBe("unparsable-url");
  });
});

describe("cspFor", () => {
  const csp = cspFor(ORIGIN);
  it("names only the bundle origin for scripts, connections and pictures, and shuts frames, workers, objects, forms and <base>", () => {
    expect(csp).toContain(`connect-src ${ORIGIN} data: blob:`);
    expect(csp).toContain(`img-src ${ORIGIN} data: blob:`);
    expect(csp).toContain(`script-src ${ORIGIN} 'unsafe-inline'`);
    for (const s of ["default-src 'none'", "worker-src 'none'", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(csp).toContain(s);
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("sandbox allow-scripts allow-same-origin");
    expect(csp).not.toMatch(/allow-popups|allow-forms|allow-top-navigation/);
    expect(csp).not.toMatch(/\*|127\.0\.0\.1:3000|https:/);
  });
});

/** A DevTools session double: records every command, answers Fetch.getResponseBody, lets a test fire events. */
function fakePage(over: { body?: () => { body: string; base64Encoded: boolean } } = {}) {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const bus = new EventEmitter();
  const client = {
    on: (name: string, fn: (e: unknown) => void) => bus.on(name, fn),
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      if (method === "Fetch.getResponseBody") {
        if (!over.body) return { value: { body: "<html><script>1</script></html>", base64Encoded: false }, size: 1 };
        return { value: over.body(), size: 1 };
      }
      return { value: {}, size: 1 };
    },
  };
  const fire = async (e: Record<string, unknown>) => {
    bus.emit("Fetch.requestPaused", e);
    await new Promise((r) => setImmediate(r)); // let the handler's awaited commands finish
  };
  const request = (id: string, url: string, resourceType = "Fetch") => fire({ requestId: id, request: { url }, resourceType });
  return { page: { _client: () => client }, sent, fire, request, find: (m: string) => sent.filter((s) => s.method === m) };
}

describe("guardPage", () => {
  it("turns the Fetch domain on (request stage for everything, response stage for documents) before the page loads", async () => {
    const f = fakePage();
    await guardPage(f.page, { origin: ORIGIN, log: () => undefined });
    expect(f.find("Fetch.enable")[0]).toEqual({ method: "Fetch.enable", params: { patterns: [{ urlPattern: "*", requestStage: "Request" }, { urlPattern: "*", resourceType: "Document", requestStage: "Response" }] } });
  });

  it("BLOCKS a scene that does new Image().src = 'http://127.0.0.1:<other port>/x' and fetch/EventSource/redirect targets to other services, and logs each", async () => {
    const f = fakePage();
    const lines: string[] = [];
    const stats = await guardPage(f.page, { origin: ORIGIN, log: (l: string) => lines.push(l) });
    await f.request("d1", `${ORIGIN}/index.html`, "Document");
    await f.request("dx", "http://127.0.0.1:3000/index.html", "Document"); // a Document before/after that is not THE bundle origin is aborted
    await f.request("i1", "http://127.0.0.1:3000/x", "Image"); // new Image().src = ...
    await f.request("f1", "http://localhost:3900/v1/voices", "Fetch");
    await f.request("e1", "http://127.0.0.1:5432/", "EventSource");
    await f.request("r1", "http://169.254.169.254/latest/meta-data/", "Fetch"); // a redirect target is a new paused request
    await f.request("b1", "http://127.0.0.1:3000/api/beacon?secret=1", "Ping");
    expect(f.find("Fetch.failRequest").map((c) => [c.params.requestId, c.params.errorReason])).toEqual([["dx", "BlockedByClient"], ["i1", "BlockedByClient"], ["f1", "BlockedByClient"], ["e1", "BlockedByClient"], ["r1", "BlockedByClient"], ["b1", "BlockedByClient"]]);
    expect(stats.blocked).toBe(6);
    expect(lines).toContain("GUARD blocked http://127.0.0.1:3000 (document-not-bundle)");
    expect(lines).toContain("GUARD blocked http://127.0.0.1:3000 (origin)");
    expect(lines.join("\n")).not.toContain("secret");
    expect(f.find("Fetch.continueRequest").map((c) => c.params.requestId)).toEqual(["d1"]);
  });

  it("lets the bundle server's own files, data: pictures and its own blob: URLs through", async () => {
    const f = fakePage();
    await guardPage(f.page, { origin: ORIGIN, log: () => undefined });
    await f.request("d1", `${ORIGIN}/index.html`, "Document");
    await f.request("s1", `${ORIGIN}/bundle.js`, "Script");
    await f.request("m1", `${ORIGIN}/public/models/pp_ship.glb`, "Fetch");
    await f.request("u1", "data:image/png;base64,AAAA", "Image");
    await f.request("b1", `blob:${ORIGIN}/abc`, "Fetch");
    expect(f.find("Fetch.continueRequest").map((c) => c.params.requestId)).toEqual(["d1", "s1", "m1", "u1", "b1"]);
    expect(f.find("Fetch.failRequest")).toHaveLength(0);
  });

  it("adds the CSP header to the main document's response, keeps the rest, and fulfils with the original body", async () => {
    const f = fakePage();
    await guardPage(f.page, { origin: ORIGIN, log: () => undefined });
    await f.request("d1", `${ORIGIN}/index.html`, "Document");
    await f.fire({ requestId: "d1", request: { url: `${ORIGIN}/index.html` }, resourceType: "Document", responseStatusCode: 200, responseHeaders: [{ name: "Content-Type", value: "text/html" }, { name: "Content-Security-Policy", value: "default-src *" }, { name: "Content-Length", value: "9" }] });
    const [c] = f.find("Fetch.fulfillRequest");
    expect(c!.params.responseCode).toBe(200);
    const headers = c!.params.responseHeaders as { name: string; value: string }[];
    expect(headers.filter((h) => h.name.toLowerCase() === "content-security-policy")).toEqual([{ name: "Content-Security-Policy", value: cspFor(ORIGIN) }]);
    expect(headers.find((h) => h.name === "Content-Type")?.value).toBe("text/html");
    expect(headers.some((h) => h.name.toLowerCase() === "content-length")).toBe(false);
    expect(Buffer.from(c!.params.body as string, "base64").toString()).toContain("<script>1</script>");
  });

  it("fails CLOSED when the CSP cannot be added, and passes error or empty responses through", async () => {
    const f = fakePage({ body: () => { throw new Error("no body"); } });
    await guardPage(f.page, { origin: ORIGIN, log: () => undefined });
    await f.request("d1", `${ORIGIN}/index.html`, "Document");
    await f.fire({ requestId: "d1", request: { url: `${ORIGIN}/index.html` }, resourceType: "Document", responseStatusCode: 200, responseHeaders: [] });
    expect(f.find("Fetch.failRequest").map((c) => c.params.requestId)).toEqual(["d1"]);
    const g = fakePage();
    await guardPage(g.page, { origin: ORIGIN, log: () => undefined });
    await g.request("d2", `${ORIGIN}/index.html`, "Document");
    await g.fire({ requestId: "d2", request: { url: `${ORIGIN}/index.html` }, resourceType: "Document", responseStatusCode: 304, responseHeaders: [] });
    expect(g.find("Fetch.continueResponse").map((c) => c.params.requestId)).toEqual(["d2"]);
  });

  it("caps the log at 50 lines per page but keeps counting", async () => {
    const f = fakePage();
    const lines: string[] = [];
    const stats = await guardPage(f.page, { origin: ORIGIN, log: (l: string) => lines.push(l) });
    await f.request("d1", `${ORIGIN}/index.html`, "Document");
    for (let i = 0; i < 80; i++) await f.request(`x${i}`, "http://127.0.0.1:3000/x", "Fetch");
    expect(lines).toHaveLength(50);
    expect(stats.blocked).toBe(80);
  });
});

describe("the page hardening commands", () => {
  it("runs a script before any page script that removes WebRTC, WebTransport, WebSocket, EventSource, workers, service workers and window.open; bypasses service workers; blocks ws:, wss:, stun:, turn:", async () => {
    const f = fakePage();
    await guardPage(f.page, { origin: ORIGIN, log: () => undefined });
    const [add] = f.find("Page.addScriptToEvaluateOnNewDocument");
    expect(add!.params.source).toBe(HARDEN_SCRIPT);
    for (const n of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "WebTransport", "WebSocket", "EventSource", "SharedWorker", "Worker", "serviceWorker", "open"]) expect(HARDEN_SCRIPT).toContain(n);
    expect(f.find("Network.setBypassServiceWorker")[0]!.params).toEqual({ bypass: true });
    expect(f.find("Network.setBlockedURLs")[0]!.params.urls).toEqual(["ws://*", "wss://*", "stun:*", "turn:*", "webrtc:*"]);
    expect(f.sent.findIndex((c) => c.method === "Page.addScriptToEvaluateOnNewDocument")).toBeLessThan(f.sent.findIndex((c) => c.method === "Fetch.enable"));
  });
  it("the hardening script really removes those names when it runs", () => {
    const g = { RTCPeerConnection: class {}, WebSocket: class {}, Worker: class {}, WebTransport: class {} } as Record<string, unknown>;
    new Function("globalThis", "navigator", "window", HARDEN_SCRIPT.replace("(() =>", "(() =>"))(g, { serviceWorker: {} }, { open: () => 1 });
    for (const n of ["RTCPeerConnection", "WebSocket", "Worker", "WebTransport"]) expect(g[n]).toBeUndefined();
  });
});

describe("guardBrowser", () => {
  const fakeBrowser = (page: unknown) => {
    const bus = new EventEmitter() as EventEmitter & { newPage: () => Promise<unknown>; connection: { send: (m: string, p: unknown) => Promise<unknown>; sent: { m: string; p: unknown }[] } };
    bus.newPage = async () => page;
    const sent: { m: string; p: unknown }[] = [];
    bus.connection = { sent, send: async (m, p) => (sent.push({ m, p }), {}) };
    return bus;
  };
  const target = (type: string, opener?: unknown, id = "t1") => ({ type: () => type, opener: () => opener, _targetId: id });
  it("closes a popup, a worker, a service worker and a shared worker the page created, counts a violation and reports it", async () => {
    const f = fakePage();
    const b = fakeBrowser(f.page);
    const seen: string[] = [];
    const lines: string[] = [];
    const stats = guardBrowser(b, { origin: ORIGIN, log: (l: string) => lines.push(l), onViolation: (t: string) => seen.push(t) });
    b.emit("targetcreated", target("page", target("page"), "popup1"));
    b.emit("targetcreated", target("service_worker", undefined, "sw1"));
    b.emit("targetcreated", target("shared_worker", undefined, "shw1"));
    b.emit("targetcreated", target("other", undefined, "x1"));
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["page", "service_worker", "shared_worker", "other"]);
    expect(stats.violations).toBe(4);
    expect(b.connection.sent.map((c) => [c.m, (c.p as { targetId: string }).targetId])).toEqual([["Target.closeTarget", "popup1"], ["Target.closeTarget", "sw1"], ["Target.closeTarget", "shw1"], ["Target.closeTarget", "x1"]]);
    expect(lines[0]).toBe("GUARD violation: a page target was created by the page");
  });
  it("lets the pages we open ourselves (no opener) and the browser target be", () => {
    const b = fakeBrowser(fakePage().page);
    const seen: string[] = [];
    const stats = guardBrowser(b, { origin: ORIGIN, log: () => undefined, onViolation: (t: string) => seen.push(t) });
    b.emit("targetcreated", target("page"));
    b.emit("targetcreated", target("browser"));
    expect(seen).toEqual([]);
    expect(stats.violations).toBe(0);
  });
  it("treats a target that cannot be inspected as a violation", () => {
    const b = fakeBrowser(fakePage().page);
    const seen: string[] = [];
    guardBrowser(b, { origin: ORIGIN, log: () => undefined, onViolation: (t: string) => seen.push(t) });
    b.emit("targetcreated", { type: () => { throw new Error("x"); }, opener: () => undefined, _targetId: "z" });
    expect(seen).toEqual(["other"]);
  });
  it("guards every page the browser opens BEFORE the caller can navigate it", async () => {
    const f = fakePage();
    const browser = fakeBrowser(f.page);
    const stats = guardBrowser(browser, { origin: ORIGIN, log: () => undefined });
    const page = await browser.newPage();
    expect(page).toBe(f.page);
    expect(f.find("Fetch.enable")).toHaveLength(1);
    expect(stats.blocked).toBe(0);
  });
});
