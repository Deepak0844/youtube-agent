// First-run setup inside compose (scripts/compose-init.ts). Pure decisions only; the script does the running.

// audio:import loads the built-in sounds into <storage>/audio; without it the sound step can never pass. Safe to run again.
export const INIT_STEPS = ["db:bootstrap", "db:migrate", "audio:import", "owner:create"] as const;
export type InitStep = (typeof INIT_STEPS)[number];

const DB_PASSWORDS = ["POSTGRES_PASSWORD", "YTSTUDIO_OWNER_PASSWORD", "YTSTUDIO_APP_PASSWORD", "YTSTUDIO_BACKUP_PASSWORD"] as const;
const REQUIRED = [...DB_PASSWORDS, "VAULT_MASTER_KEY"] as const; // the render service token is checked by the service itself: init never receives it

/** The reason to refuse before anything starts: the first secret that is missing or still the example placeholder. */
export function refuseInit(env: Record<string, string | undefined>): string | null {
  for (const key of REQUIRED) {
    const v = env[key];
    if (v === undefined || v.trim() === "") return `Set real passwords in .env: ${key} is missing.`;
    if (v === "CHANGE_ME") return `Set real passwords in .env: ${key} is still CHANGE_ME.`;
  }
  // The database passwords go into postgres:// addresses unescaped; anything outside the URL-safe set would break them silently.
  for (const key of DB_PASSWORDS) {
    if (!/^[A-Za-z0-9._~-]+$/.test(env[key]!)) return `${key} in .env may only use letters, digits and - _ . ~ (it goes into a database address).`;
  }
  return null;
}

/** ok / skip (this step has nothing to do) / fail (stop). Only owner:create may skip: a second run finds the owner already made. */
export function stepOutcome(step: InitStep, exitCode: number, stderr: string): "ok" | "skip" | "fail" {
  if (exitCode === 0) return "ok";
  return step === "owner:create" && stderr.includes("An owner already exists") ? "skip" : "fail";
}
