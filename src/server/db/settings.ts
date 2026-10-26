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
