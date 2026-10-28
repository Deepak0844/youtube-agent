import { headers } from "next/headers";
import { actionOriginProblem } from "./origin";

/** Server actions that move money or publish: a missing or foreign Origin is refused (Next alone lets an Origin-less POST through). Returns a sentence, or null. */
export async function assertActionOrigin(): Promise<string | null> {
  return actionOriginProblem(await headers()) ? "That request did not come from this page. Nothing was changed." : null;
}
