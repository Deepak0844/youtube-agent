"use server";

import { redirect } from "next/navigation";
import { consumeSetupLink } from "@/server/db/owner";
import { getPool } from "@/server/db/pool";

export interface SetupState {
  invalid?: boolean;
  error?: string;
}
const str = (v: FormDataEntryValue | null, max: number): string => (typeof v === "string" && v.length <= max ? v : "");

// The one-time link token is the credential. invalid/expired/used all collapse to the same neutral answer.
export async function setupAction(_prev: SetupState, form: FormData): Promise<SetupState> {
  const password = str(form.get("password"), 1024);
  if (password !== str(form.get("confirm"), 1024)) return { error: "The two passwords do not match." };
  const r = await consumeSetupLink(getPool(), str(form.get("token"), 256), { username: str(form.get("username"), 200), password });
  if (r.ok) redirect("/login");
  if (r.reason === "weak_password") return { error: "Choose a password of at least 12 characters that is not a common one." };
  if (r.reason === "bad_username") return { error: "Username must be 3 to 64 characters: letters, digits, dot, dash or underscore." };
  return { invalid: true };
}
