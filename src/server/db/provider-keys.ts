// Provider API keys on top of the vault. Plaintext exists only inside save (argument) and test (decrypted for one request);
// listings come from the stored masked tail. Every change writes an audit row with provider + tail, never the key.
// "Last test" is read back from the audit log (latest key.set / key.removed / key.tested per provider), so a replaced or
// removed key shows "never tested" without a second table.
import type pg from "pg";
import {
  PROVIDERS,
  checkKeyShape,
  isProviderId,
  secretName,
  type KeyTestResult,
  type ProviderId,
  type VaultState,
} from "@/server/core/provider-keys";
import { hintFor, type Keyring } from "@/server/core/vault-crypto";
import { recordAudit } from "@/server/db/audit";
import { deleteSecret, getSecret, hasSecret, listSecrets, putSecret, vaultStatus } from "@/server/db/vault";
import { runKeyTest, type KeyFetcher } from "@/server/providers/key-test";

type Db = Pick<pg.Pool, "query">;
export type KeyringLoader = () => Keyring;

export interface ProviderKeyRow {
  id: ProviderId;
  isSet: boolean;
  tail: string;
  updatedAt: Date | null;
  lastTest: { at: Date; result: KeyTestResult } | null;
}
export type KeyOutcome = { ok: true } | { ok: false; message: string };
export type TestOutcome = { ok: true; result: KeyTestResult } | { ok: false; message: string };

const TEST_COOLDOWN_MS = 8000;
const GENERIC = "Could not complete that. Nothing was changed.";

/** Does the loaded master key open every stored entry? Never throws for a missing key. */
export async function getVaultState(db: Db, loader: KeyringLoader): Promise<VaultState> {
  return (await vaultStatus(db, loader)).status;
}

export async function listProviderKeys(db: Db): Promise<ProviderKeyRow[]> {
  const secrets = new Map((await listSecrets(db)).map((s) => [s.name, s]));
  const { rows } = await db.query<{ provider: string; event: string; result: string | null; at: Date }>(
    `select distinct on (detail->>'provider') detail->>'provider' as provider, event, detail->>'result' as result, at
       from audit_log
      where event in ('key.set', 'key.removed', 'key.tested') and detail ? 'provider'
      order by detail->>'provider', id desc`,
  );
  const last = new Map(rows.map((r) => [r.provider, r]));
  return PROVIDERS.map((p) => {
    const s = secrets.get(secretName(p.id));
    const l = last.get(p.id);
    const tested = s && l?.event === "key.tested" && (l.result === "ok" || l.result === "rejected" || l.result === "unreachable");
    return {
      id: p.id,
      isSet: Boolean(s),
      tail: s?.hint ?? "",
      updatedAt: s?.updatedAt ?? null,
      lastTest: tested ? { at: l.at, result: l.result as KeyTestResult } : null,
    };
  });
}

async function ringIfHealthy(db: Db, loader: KeyringLoader): Promise<Keyring | null> {
  if ((await getVaultState(db, loader)) !== "ok") return null;
  return loader();
}

export async function saveProviderKey(db: Db, loader: KeyringLoader, id: string, raw: unknown): Promise<KeyOutcome> {
  if (!isProviderId(id)) return { ok: false, message: "Unknown provider." };
  const shape = checkKeyShape(id, raw);
  if (!shape.ok) return shape;
  try {
    const ring = await ringIfHealthy(db, loader); // fail closed: never write under a key that does not open the vault
    if (!ring) return { ok: false, message: "The vault is not ready, so nothing was saved." };
    const replaced = await hasSecret(db, secretName(id));
    await putSecret(db, ring, secretName(id), shape.value);
    await recordAudit(db as pg.Pool, "key.set", { provider: id, tail: hintFor(shape.value), replaced });
    return { ok: true };
  } catch {
    return { ok: false, message: GENERIC }; // no error text: it could carry request context
  }
}

export async function removeProviderKey(db: Db, id: string): Promise<KeyOutcome> {
  if (!isProviderId(id)) return { ok: false, message: "Unknown provider." };
  try {
    if (await deleteSecret(db, secretName(id))) await recordAudit(db as pg.Pool, "key.removed", { provider: id });
    return { ok: true };
  } catch {
    return { ok: false, message: GENERIC };
  }
}

/** One free request with the stored key. Records the verdict (audit + last test); the response body is never read. */
export async function testProviderKey(db: Db, loader: KeyringLoader, id: string, opts: { fetcher?: KeyFetcher; cooldownMs?: number } = {}): Promise<TestOutcome> {
  if (!isProviderId(id)) return { ok: false, message: "Unknown provider." };
  try {
    const ring = await ringIfHealthy(db, loader);
    if (!ring) return { ok: false, message: "The vault is not ready, so the key cannot be tested." };
    if (!(await hasSecret(db, secretName(id)))) return { ok: false, message: "No key is saved for this provider." };
    // Per-provider cooldown, judged by the database clock from the last recorded test: a hammered Test button cannot spam the provider.
    const recent = await db.query(
      "select 1 from audit_log where event = 'key.tested' and detail->>'provider' = $1 and at > now() - ($2::double precision * interval '1 millisecond') limit 1",
      [id, opts.cooldownMs ?? TEST_COOLDOWN_MS],
    );
    if (recent.rows.length > 0) return { ok: false, message: "Try again shortly." };
    const key = await getSecret(db, ring, secretName(id));
    const result = await runKeyTest(id, key, { fetcher: opts.fetcher });
    await recordAudit(db as pg.Pool, "key.tested", { provider: id, result });
    return { ok: true, result };
  } catch {
    return { ok: false, message: GENERIC };
  }
}
