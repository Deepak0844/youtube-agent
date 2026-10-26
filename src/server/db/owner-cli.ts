import { createPool } from "@/server/db/pool";
import { migrate } from "@/server/db/migrate";
import { audit, createSetupLink, lockOwner, ownerExists, revokeAllSessions } from "@/server/db/owner";
import { atomic, type Db } from "@/server/db/stages";

// CLI logic, in-process testable. stdout carries ONLY the one-time link (one line); messages go to stderr.
export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function appUrl(env: Record<string, string | undefined>): string | null {
  const raw = (env.APP_URL?.trim() || "http://localhost:3000").replace(/\/+$/, "");
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

const fail = (stderr: string): CliResult => ({ exitCode: 1, stdout: "", stderr: `${stderr}\n` });

export async function runOwnerCreate(db: Db, env: Record<string, string | undefined>): Promise<CliResult> {
  const base = appUrl(env);
  if (!base) return fail("APP_URL must be an http(s) URL");
  const link = await atomic(db, async (qc) => {
    const q = qc as Db; // atomic always hands over a PoolClient (or the caller's client)
    await lockOwner(q);
    if (await ownerExists(q)) return null;
    const l = await createSetupLink(q, "create", base);
    await audit(q, "owner.create_link");
    return l;
  });
  if (link === null) return fail("An owner already exists. Use `npm run owner:reset` to recover access.");
  return { exitCode: 0, stdout: `${link}\n`, stderr: "" };
}

export async function runOwnerReset(db: Db, env: Record<string, string | undefined>): Promise<CliResult> {
  const base = appUrl(env);
  if (!base) return fail("APP_URL must be an http(s) URL");
  const link = await atomic(db, async (qc) => {
    const q = qc as Db; // atomic always hands over a PoolClient (or the caller's client)
    await lockOwner(q); // lock order: owner first, then setup links (see owner.ts)
    const { rows } = await q.query("select 1 from owner where id = 1 for update");
    if (rows.length === 0) return null;
    // Only sessions die now. TOTP and recovery codes stay enforced until the link is consumed, so a pending reset never weakens login.
    const sessionsRevoked = await revokeAllSessions(q);
    const l = await createSetupLink(q, "reset", base);
    await audit(q, "owner.reset_link", { sessionsRevoked });
    return l;
  });
  if (link === null) return fail("No owner exists. Use `npm run owner:create` first.");
  return { exitCode: 0, stdout: `${link}\n`, stderr: "" };
}

export async function cliMain(run: (db: Db, env: Record<string, string | undefined>) => Promise<CliResult>): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL is not set\n");
    process.exitCode = 1;
    return;
  }
  const pool = createPool(url);
  try {
    await migrate(pool);
    const r = await run(pool, process.env);
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    process.exitCode = r.exitCode;
  } catch (err) {
    process.stderr.write(`failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}
