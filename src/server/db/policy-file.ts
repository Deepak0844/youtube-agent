import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePolicy, POLICY_DEFAULTS, type Policy } from "@/server/core/policy";

/** Reads ops/policy.json (relative to the working directory) if it exists; anything unreadable gives the built-in defaults. */
export function loadPolicy(file: string = path.join(process.cwd(), "ops", "policy.json")): Policy {
  try {
    return parsePolicy(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { ...POLICY_DEFAULTS };
  }
}
