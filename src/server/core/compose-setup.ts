// First-run setup inside compose (scripts/compose-init.ts). Pure decisions only; the script does the running.

export const INIT_STEPS = ["db:bootstrap", "db:migrate", "owner:create"] as const;
export type InitStep = (typeof INIT_STEPS)[number];

const REQUIRED = ["POSTGRES_PASSWORD", "YTSTUDIO_OWNER_PASSWORD", "YTSTUDIO_APP_PASSWORD", "YTSTUDIO_BACKUP_PASSWORD", "VAULT_MASTER_KEY"] as const;

/** The reason to refuse before anything starts: the first secret that is missing or still the example placeholder. */
export function refuseInit(env: Record<string, string | undefined>): string | null {
  for (const key of REQUIRED) {
    const v = env[key];
    if (v === undefined || v.trim() === "") return `Set real passwords in .env: ${key} is missing.`;
    if (v === "CHANGE_ME") return `Set real passwords in .env: ${key} is still CHANGE_ME.`;
  }
  return null;
}

/** ok / skip (this step has nothing to do) / fail (stop). Only owner:create may skip: a second run finds the owner already made. */
export function stepOutcome(step: InitStep, exitCode: number, stderr: string): "ok" | "skip" | "fail" {
  if (exitCode === 0) return "ok";
  return step === "owner:create" && stderr.includes("An owner already exists") ? "skip" : "fail";
}
