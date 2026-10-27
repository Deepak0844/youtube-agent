// DB side of the owner's Google app. The client secret is written ONLY through the vault; this table holds the client id
// and the vault name. Nothing here returns the secret: views carry a masked hint (empty for short values) and booleans.
// No network call to Google lives here (the real consent flow is Phase 5).
import type pg from "pg";
import { googleAppInput, SECRET_NAME, validateClientId, validateClientSecret, validateRedirectUri, redirectUriFor } from "@/server/core/google-app";
import type { Keyring } from "@/server/core/vault-crypto";
import { recordAudit } from "@/server/db/audit";
import { getSecret, putSecret, vaultStatus } from "@/server/db/vault";

type Db = Pick<pg.Pool, "query">;

export interface OwnGoogleApp {
  clientId: string;
  secretStored: boolean;
  secretHint: string;
  updatedAt: Date;
}
export interface LegacyGoogleApp {
  clientId: string;
}

export async function getOwnGoogleApp(db: Db): Promise<OwnGoogleApp | null> {
  const { rows } = await db.query<{ client_id: string; updated_at: Date; hint: string | null }>(
    `select g.client_id, g.updated_at, s.hint from google_apps g left join secrets s on s.name = g.client_secret_name where g.kind = 'own'`,
  );
  const r = rows[0];
  return r ? { clientId: r.client_id, secretStored: r.hint !== null, secretHint: r.hint ?? "", updatedAt: r.updated_at } : null;
}

export async function listLegacyGoogleApps(db: Db): Promise<LegacyGoogleApp[]> {
  const { rows } = await db.query<{ client_id: string }>("select client_id from google_apps where kind = 'legacy' order by created_at");
  return rows.map((r) => ({ clientId: r.client_id }));
}

export type SaveResult = { ok: true } | { ok: false; reason: "vault" } | { ok: false; reason: "invalid"; fieldErrors: Record<string, string> };

/** Blank/undefined fields keep what is stored. One transaction: vault write, row upsert, audit row. Fails closed on any vault problem. */
export async function saveOwnGoogleApp(
  pool: pg.Pool,
  ring: Keyring | (() => Keyring),
  input: { clientId?: string; clientSecret?: string },
): Promise<SaveResult> {
  // The vault must be usable and must open every stored entry before we write anything.
  let status;
  try {
    status = await vaultStatus(pool, ring);
  } catch {
    return { ok: false, reason: "vault" };
  }
  if (status.status !== "ok") return { ok: false, reason: "vault" };
  const keyring = typeof ring === "function" ? ring() : ring;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const cur = await client.query<{ client_id: string }>("select client_id from google_apps where kind = 'own' for update");
    const hasSecret = ((await client.query("select 1 from secrets where name = $1", [SECRET_NAME])).rowCount ?? 0) > 0;
    const parsed = googleAppInput(
      { clientId: input.clientId ?? "", clientSecret: input.clientSecret ?? "" },
      { hasId: cur.rows.length > 0, hasSecret },
    );
    if (!parsed.ok) {
      await client.query("rollback");
      return { ok: false, reason: "invalid", fieldErrors: parsed.fieldErrors as Record<string, string> };
    }
    const changed: string[] = [];
    if (parsed.clientSecret !== undefined) {
      await putSecret(client, keyring, SECRET_NAME, parsed.clientSecret);
      changed.push("client_secret");
    }
    if (cur.rows.length === 0 || (parsed.clientId !== undefined && parsed.clientId !== cur.rows[0]!.client_id)) {
      await client.query(
        `insert into google_apps (kind, client_id, client_secret_name) values ('own', $1, $2)
         on conflict (kind) where kind = 'own' do update set client_id = excluded.client_id, updated_at = now()`,
        [parsed.clientId ?? cur.rows[0]!.client_id, SECRET_NAME],
      );
      changed.unshift("client_id");
    } else if (changed.length) {
      await client.query("update google_apps set updated_at = now() where kind = 'own'");
    }
    // Names only: the audit writer would blank anything secret-looking, and no value belongs here anyway.
    await recordAudit(client, "google_app.saved", { kind: "own", changed });
    await client.query("commit");
    return { ok: true };
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface FormatTest {
  clientId: boolean;
  secret: boolean;
  redirectUri: boolean;
}

/** FORMAT ONLY. No network. Decrypts the secret in memory to check its shape and returns booleans; the value never leaves this function. */
export async function testOwnGoogleApp(db: Db, ring: Keyring | (() => Keyring), appUrl: string | undefined): Promise<FormatTest> {
  const app = await getOwnGoogleApp(db);
  const redirect = redirectUriFor(appUrl);
  const out: FormatTest = { clientId: !!app && validateClientId(app.clientId).ok, secret: false, redirectUri: redirect.ok && validateRedirectUri(redirect.uri) };
  if (app?.secretStored) {
    try {
      const keyring = typeof ring === "function" ? ring() : ring;
      out.secret = validateClientSecret(await getSecret(db, keyring, SECRET_NAME)).ok;
    } catch {
      out.secret = false;
    }
  }
  return out;
}
