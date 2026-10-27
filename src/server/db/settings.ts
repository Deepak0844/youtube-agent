import type pg from "pg";
import { SETTINGS, isSettingKey, parseSetting, type SettingDef } from "@/server/core/settings-registry";

export type Actor = "session" | "token" | "system";

export async function getSetting(db: pg.Pool | pg.PoolClient, key: string): Promise<unknown> {
  if (!isSettingKey(key)) throw new Error(`unknown setting: ${key}`);
  const { rows } = await db.query<{ value: unknown }>("select value from settings where key = $1", [key]);
  return rows.length > 0 ? rows[0]!.value : (SETTINGS as Record<string, SettingDef>)[key]!.default;
}

// Returns old/new so the caller can audit. Safety keys are session-only (Doc 02 4.6).
export async function setSetting(
  db: pg.Pool,
  key: string,
  value: unknown,
  opts: { actor: Actor },
): Promise<{ old: unknown; new: unknown }> {
  const parsed = parseSetting(key, value);
  if (SETTINGS[key as keyof typeof SETTINGS].safety && opts.actor !== "session") {
    throw new Error(`setting ${key} can only be changed by a logged-in session`);
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    const prev = await getSettingForUpdate(client, key);
    await client.query(
      `insert into settings (key, value, updated_at, updated_by) values ($1, $2::jsonb, now(), $3)
       on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      [key, JSON.stringify(parsed), opts.actor],
    );
    await client.query("commit");
    return { old: prev, new: parsed };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function getSettingForUpdate(client: pg.PoolClient, key: string): Promise<unknown> {
  const { rows } = await client.query<{ value: unknown }>("select value from settings where key = $1 for update", [key]);
  return rows.length > 0 ? rows[0]!.value : (SETTINGS as Record<string, SettingDef>)[key]!.default;
}

/** The only keys setSessionSettings may write: what /settings/system saves. Other safety keys (policies) need their own reviewed path. */
export const SESSION_BATCH_KEYS: readonly string[] = [
  "network.local_services",
  "jobs.concurrent_renders",
  "jobs.concurrent_jobs",
  "storage.warn_gb",
  "video.max_long_minutes",
  "tracks.enabled",
];

export interface SessionWrite {
  key: string;
  /** The new value, or a function of the current one (read under the transaction's lock). */
  value: unknown | ((current: unknown) => unknown);
}

/**
 * Several settings written as the logged-in session in ONE transaction, serialised against other callers by an advisory
 * lock, so two concurrent saves cannot interleave their keys. `onChange` runs in the same transaction for every key (it
 * is where the audit row goes); if it or any write throws, none of the keys change. There is no actor argument on
 * purpose: this path can only ever write as a session, which is what safety keys require.
 */
export async function setSessionSettings(
  db: pg.Pool,
  writes: readonly SessionWrite[],
  onChange: (client: pg.PoolClient, key: string, change: { old: unknown; new: unknown }) => Promise<void>,
): Promise<Array<{ key: string; old: unknown; new: unknown }>> {
  // Checked before the database is touched: a batch with one key outside the set writes nothing.
  for (const w of writes) {
    if (!isSettingKey(w.key)) throw new Error(`unknown setting: ${w.key}`);
    if (!SESSION_BATCH_KEYS.includes(w.key)) throw new Error(`setting ${w.key} is not writable here`);
  }
  const client = await db.connect();
  try {
    await client.query("begin");
    // Advisory-lock key space: one app-wide key per feature, hashed from a dotted name under "ytstudio." (the settings
    // page batch is "ytstudio.settings.session-batch"). Pick a new distinct name for any other advisory lock.
    await client.query("select pg_advisory_xact_lock(hashtext('ytstudio.settings.session-batch'))");
    const out: Array<{ key: string; old: unknown; new: unknown }> = [];
    for (const w of writes) {
      if (!isSettingKey(w.key)) throw new Error(`unknown setting: ${w.key}`);
      const prev = await getSettingForUpdate(client, w.key);
      const next = parseSetting(w.key, typeof w.value === "function" ? (w.value as (c: unknown) => unknown)(prev) : w.value);
      await client.query(
        `insert into settings (key, value, updated_at, updated_by) values ($1, $2::jsonb, now(), 'session')
         on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
        [w.key, JSON.stringify(next)],
      );
      await onChange(client, w.key, { old: prev, new: next });
      out.push({ key: w.key, old: prev, new: next });
    }
    await client.query("commit");
    return out;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
