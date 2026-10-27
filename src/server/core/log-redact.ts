// Pure line hygiene for job logs and event payloads. No IO.
//
// redactLine removes anything credential-shaped; compactLine shrinks oversized lines. Both keep a JSON line valid JSON
// (a log line that parsed before still parses after), because the UI may render structured lines.
export const REDACTED = "[redacted]";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Names whose value is secret: env-style (VAULT_MASTER_KEY), dotted vault names (media.signing) and JSON-ish keys.
const SENSITIVE_NAME = /(?:key|secret|token|password|passwd|signing|authorization|cookie)/i;

// Order matters: header/vault forms first (they swallow a whole value), then shapes, then the generic long run.
const TEXT_RULES: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  [/(\bauthorization["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+(?:[ \t]+[^\s,;&]+)?)/gi, `$1${REDACTED}`],
  [/(\b[\w.-]*(?:key|secret|token|password|passwd|signing)[\w.-]*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&"']+)/gi, `$1${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/([?&](?:e|s|sig|signature|expires|token|key|access_token|x-amz-signature)=)[^&\s"'#]*/gi, `$1${REDACTED}`],
  [/\b(?:sk|gsk|xai|pplx|ya29|ghp|gho|xox[abp])[-_][A-Za-z0-9_.-]{8,}/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, REDACTED],
  // 32+ url-safe characters in a row (audit rule). A bare UUID is an id, not a secret.
  [/[A-Za-z0-9_+/=-]{32,}/g, (m) => (UUID.test(m) ? m : REDACTED)],
];

function redactText(s: string): string {
  let out = s;
  for (const [re, to] of TEXT_RULES) out = out.replace(re, to as string);
  return out;
}

/** Same rules as redactLine for plain text, minus the generic "32+ url-safe characters" rule that mangles ordinary URLs. */
export function redactSecretShapes(s: string): string {
  let out = s;
  for (const [re, to] of TEXT_RULES.slice(0, -1)) out = out.replace(re, to as string);
  return out;
}

function redactValue(v: unknown, key?: string): unknown {
  if (key !== undefined && SENSITIVE_NAME.test(key) && v !== null && v !== "") return REDACTED;
  if (typeof v === "string") return redactText(v);
  if (Array.isArray(v)) return v.map((x) => redactValue(x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactValue(x, k)]));
  return v;
}

function parseJsonContainer(line: string): object | null {
  const t = line.trimStart();
  if (t[0] !== "{" && t[0] !== "[") return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** Removes provider keys, Bearer/Authorization values, signed-URL params, secret-named values and long token-like runs. */
export function redactLine(line: string): string {
  const json = parseJsonContainer(line);
  if (json) {
    const clean = redactValue(json);
    const out = JSON.stringify(clean);
    // Untouched JSON keeps its original spacing: a harmless line must come back byte for byte.
    return JSON.stringify(json) === out ? line : out;
  }
  return redactText(line);
}

const BASE64_RUN = /[A-Za-z0-9+/]{200,}={0,2}/g;
const DATA_URI = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g;
const bytes = (s: string) => Buffer.byteLength(s);

function cutToBytes(s: string, max: number): string {
  if (bytes(s) <= max) return s;
  let buf = Buffer.from(s).subarray(0, max);
  // Drop a partial multi-byte character at the end.
  let end = buf.length;
  while (end > 0 && (buf[end - 1]! & 0xc0) === 0x80) end--;
  if (end > 0 && buf[end - 1]! >= 0xc0) end--;
  buf = buf.subarray(0, end);
  return buf.toString("utf8");
}

function shrinkJson(v: unknown, strMax: number, arrMax: number): unknown {
  if (typeof v === "string") {
    if (v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v)) return `[base64 ${v.length} chars]`;
    if (v.startsWith("data:") && v.includes(";base64,")) return `[data uri ${v.length} chars]`;
    return v.length > strMax ? `${v.slice(0, strMax)}...[+${v.length - strMax} chars]` : v;
  }
  if (Array.isArray(v)) {
    const head = v.slice(0, arrMax).map((x) => shrinkJson(x, strMax, arrMax));
    return v.length > arrMax ? [...head, `[+${v.length - arrMax} more items]`] : head;
  }
  if (v && typeof v === "object") {
    const entries = Object.entries(v);
    const kept = entries.slice(0, Math.max(arrMax, 8)).map(([k, x]) => [k, shrinkJson(x, strMax, arrMax)] as const);
    const obj = Object.fromEntries(kept);
    if (entries.length > kept.length) obj["_truncated"] = `+${entries.length - kept.length} more fields`;
    return obj;
  }
  return v;
}

/** Shrinks a line to at most maxBytes. A JSON line stays valid JSON; plain text is cut on a character boundary. */
export function compactLine(line: string, maxBytes = 4096): string {
  if (bytes(line) <= maxBytes) return line;
  const json = parseJsonContainer(line);
  if (json) {
    for (const [strMax, arrMax] of [[200, 20], [80, 10], [32, 5], [12, 3]] as const) {
      const out = JSON.stringify(shrinkJson(json, strMax, arrMax));
      if (bytes(out) <= maxBytes) return out;
    }
    const fallback = JSON.stringify({ truncated: true, bytes: bytes(line) });
    return bytes(fallback) <= maxBytes ? fallback : "{}";
  }
  const flat = line.replace(DATA_URI, (m) => `[data uri ${m.length} chars]`).replace(BASE64_RUN, (m) => `[base64 ${m.length} chars]`);
  if (bytes(flat) <= maxBytes) return flat;
  const marker = `...[truncated ${bytes(flat)} bytes]`;
  return cutToBytes(flat, Math.max(0, maxBytes - bytes(marker))) + (bytes(marker) <= maxBytes ? marker : "");
}
