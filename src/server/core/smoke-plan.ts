import { redactSecretShapes } from "./log-redact";

// Pure planning and redaction for the owner-run live provider smoke (scripts/provider-smoke.ts). No IO.
export const HARD_MAX_USD = 2;
export const DEFAULT_CAP_USD = 0.5;

export class SmokeRefusal extends Error {}

export interface SmokeArgs { providers: string[]; capUsd: number; langs: string[]; yesSpend: boolean; dryPlan: boolean; voice?: string }

export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const val = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const list = (s: string | undefined, d: string) => (s ?? d).split(",").map((x) => x.trim()).filter(Boolean);
  const capUsd = val("cap") === undefined ? DEFAULT_CAP_USD : Number(val("cap"));
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new SmokeRefusal("--cap must be a number above 0 (USD). Nothing was sent.");
  if (capUsd > HARD_MAX_USD) throw new SmokeRefusal(`--cap is over the hard limit of ${HARD_MAX_USD} USD. Nothing was sent.`);
  const voice = val("voice");
  return { providers: list(val("providers"), "elevenlabs,pixabay"), capUsd, langs: list(val("lang"), "en,hi,ta"), yesSpend: argv.includes("--yes-spend"), dryPlan: argv.includes("--dry-plan"), ...(voice ? { voice } : {}) };
}

/** Only a local development database, never a production-like environment. */
export function refuseEnvironment(env: Record<string, string | undefined>): void {
  if (/^prod/i.test(env.NODE_ENV ?? "")) throw new SmokeRefusal("Refused: this looks like a production environment.");
  let host = "";
  try { host = new URL(env.DATABASE_URL ?? "").hostname; } catch { /* refused below */ }
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) throw new SmokeRefusal("Refused: DATABASE_URL must point at the local development database (localhost).");
}

export interface Candidate {
  id: string;
  /** Key slot / provider the call belongs to: elevenlabs, pixabay, edge. */
  provider: string;
  label: string;
  quoteMicro: number;
  needsKey: boolean;
  /** ElevenLabs characters (or credits) this call needs from the allowance. */
  chars?: number;
  /** Dropped, not refused, when the cap cannot fit it. */
  optional?: boolean;
}
export interface Plan<C extends Candidate = Candidate> { calls: C[]; skipped: Array<{ id: string; why: string }>; totalMicro: number }

export function planSmoke<C extends Candidate>(a: {
  candidates: C[]; selected: ReadonlySet<string>; haveKey: (provider: string) => boolean; capMicro: number;
  interactive: boolean; yesSpend: boolean; allowanceChars: number | null;
}): Plan<C> {
  const calls: C[] = [];
  const skipped: Plan["skipped"] = [];
  let total = 0;
  let chars = 0;
  for (const c of a.candidates) {
    if (!a.selected.has(c.provider)) continue;
    if (c.needsKey && !a.haveKey(c.provider)) { skipped.push({ id: c.id, why: `No ${c.provider} key is saved (Keys page), so this was skipped.` }); continue; }
    if (a.allowanceChars !== null && c.chars !== undefined && chars + c.chars > a.allowanceChars) { skipped.push({ id: c.id, why: "The ElevenLabs allowance cannot cover this call." }); continue; }
    if (total + c.quoteMicro > a.capMicro) {
      if (!c.optional) throw new SmokeRefusal(`The quotes add up to more than the cap (${a.capMicro} micro-USD). Nothing was sent.`);
      skipped.push({ id: c.id, why: "Its quote does not fit the cap." });
      continue;
    }
    calls.push(c);
    total += c.quoteMicro;
    chars += c.chars ?? 0;
  }
  if (total > 0 && !a.interactive && !a.yesSpend) throw new SmokeRefusal("This run would spend money and there is no terminal to ask you. Re-run with --yes-spend, or run it in a terminal. Nothing was sent.");
  return { calls, skipped, totalMicro: total };
}

/** Provider response text made safe to write to disk: the actual keys, then every credential shape. */
export function redactFixture(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[redacted]");
  return redactSecretShapes(out);
}

export function moneyAnomalies(capMicro: number, rows: Array<{ id: string; quoteMicro: number; recordedMicro: number }>): string[] {
  const out = rows.filter((r) => r.recordedMicro > r.quoteMicro).map((r) => `${r.id}: recorded ${r.recordedMicro} is above the quote ${r.quoteMicro}`);
  const spent = rows.reduce((n, r) => n + r.recordedMicro, 0);
  if (spent > capMicro) out.push(`total spend ${spent} is above the cap ${capMicro}`);
  return out;
}

export type Verdict = "confirmed" | "differs" | "refused by plan" | "not run";
export const formatSummary = (rows: Array<{ item: string; verdict: Verdict; detail: string }>): string =>
  rows.map((r) => `| ${r.item} | ${r.verdict} | ${r.detail} |`).join("\n");
