import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { isIP } from "node:net";

// TEST-ONLY hooks for the egress proxy. They exist so integration tests can (a) simulate DNS answers
// without real DNS and (b) read the proxy's decisions. Both are off unless NODE_ENV=test AND
// PROXY_TEST_TOKEN is a 64-hex-char secret; the admin endpoint binds to loopback only and also
// demands that token. With hooks off, nothing here runs and the proxy behaves as in production.

export const ADMIN_PORT = 3129;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const LOG_CAP = 2000;

export interface TestHooks {
  override(host: string): string[] | undefined;
  record(entry: object): void;
}

function parseOverride(spec: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const pair of spec.split(",").filter(Boolean)) {
    const eq = pair.indexOf("=");
    const name = pair.slice(0, eq).trim().toLowerCase();
    const address = pair.slice(eq + 1).trim();
    if (eq <= 0 || isIP(address) === 0) throw new Error(`RESOLVE_OVERRIDE: bad entry ${JSON.stringify(pair)}`);
    map.set(name, [...(map.get(name) ?? []), address]);
  }
  return map;
}

function tokenMatches(header: string | undefined, token: Buffer): boolean {
  const given = Buffer.from(/^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "");
  return given.length === token.length && timingSafeEqual(given, token);
}

export function loadTestHooks(env: NodeJS.ProcessEnv): TestHooks | undefined {
  const requested = env.RESOLVE_OVERRIDE !== undefined || env.PROXY_TEST_TOKEN !== undefined;
  if (env.NODE_ENV !== "test" || !TOKEN_RE.test(env.PROXY_TEST_TOKEN ?? "")) {
    if (requested) console.error(JSON.stringify({ msg: "test-only settings ignored (needs NODE_ENV=test and a 64-hex PROXY_TEST_TOKEN)" }));
    return undefined;
  }
  const token = Buffer.from(env.PROXY_TEST_TOKEN as string);
  const overrides = parseOverride(env.RESOLVE_OVERRIDE ?? "");
  const logs: object[] = [];

  http
    .createServer((req, res) => {
      if (!tokenMatches(req.headers.authorization, token)) {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== "GET" || req.url !== "/logs") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(logs));
    })
    .listen(ADMIN_PORT, "127.0.0.1");

  console.error(JSON.stringify({ msg: "TEST HOOKS ENABLED", overrides: [...overrides.keys()], admin: `127.0.0.1:${ADMIN_PORT}` }));
  return {
    override: (host) => overrides.get(host.toLowerCase()),
    record(entry) {
      logs.push(entry);
      if (logs.length > LOG_CAP) logs.shift();
    },
  };
}
