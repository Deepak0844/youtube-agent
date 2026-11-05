import type { Message } from "@/server/core/agent-loop";
import { KnownFailure } from "@/server/core/paid-call";
import { AUTHOR_MAX_ATTEMPTS, authorMessages, extractScene, retryPrompt } from "@/server/core/scene3d-author-prompt";
import { sha256Hex } from "@/server/core/content-hash";
import { checkScene3dCode } from "@/server/core/scene3d-code-check";

// The author loop of a scene3d_code video: ask, extract the file, check it statically, type-check it, and feed ALL problems back (at most 12)
// for up to 4 attempts. Nothing here runs the code. The model call is injected and is the reserved, budget-scoped paid call: a refused budget
// or an unclear paid outcome goes up untouched and is never retried here.

export type TypeVerdict = { ok: boolean; problems: string[]; sha256?: string; fatal?: boolean };
export type AskText = (messages: Message[]) => Promise<string>;
export interface AuthorDeps {
  ask: AskText;
  /** The in-process type-check (scene3d-typecheck.ts). */
  typeCheck(source: string): TypeVerdict | Promise<TypeVerdict>;
  log(line: string): void;
}

/** The first sentence, short: the stored stage error is cut at about 120 characters, so the key sentence must come first. */
const key = (p: string) => p.replace(/\s+/g, " ").slice(0, 100);

const stop = (why: string) => new KnownFailure(`scene3d_typecheck_failed: ${why} The scene was not accepted. Nothing was rendered. Run the author step again.`.slice(0, 600));

export async function authorScene3d(deps: AuthorDeps, task: Parameters<typeof authorMessages>[0]): Promise<{ source: string; attempts: number; typecheckedSha256: string }> {
  const messages: Message[] = authorMessages(task);
  let last: string[] = [];
  for (let attempt = 1; attempt <= AUTHOR_MAX_ATTEMPTS; attempt++) {
    const reply = await deps.ask(messages);
    const ex = extractScene(reply);
    let problems: string[];
    if (!ex.ok) problems = [ex.problem];
    else {
      const checked = checkScene3dCode(ex.source);
      if (!checked.ok) problems = checked.problems;
      else {
        // Layer 2 must have run AND passed on exactly these bytes. A crash, timeout or unreadable result is a STOP, never a hint for the model.
        let typed: TypeVerdict;
        try {
          typed = await deps.typeCheck(ex.source);
        } catch {
          throw stop("the type-check crashed.");
        }
        if (typed.fatal) throw stop((typed.problems[0] ?? "the type-check could not finish.").slice(0, 100));
        const sha = sha256Hex(ex.source);
        if (typed.ok) {
          if (typed.sha256 !== sha) throw stop("the type-check did not confirm it checked these exact bytes.");
          deps.log(`author: scene accepted on attempt ${attempt} (${ex.source.length} characters)`);
          return { source: ex.source, attempts: attempt, typecheckedSha256: sha };
        }
        problems = typed.problems;
      }
    }
    last = problems;
    deps.log(`author: scene rejected on attempt ${attempt}: ${problems.slice(0, 3).map(key).join("; ")}`.slice(0, 300));
    deps.log(`author: rejected reply, attempt ${attempt}: ${JSON.stringify(String(reply).slice(0, 6000))}`); // our own model's text, kept in the stage log for diagnosis
    messages.push({ role: "assistant", content: String(reply).slice(0, 70_000), toolCalls: [] });
    messages.push({ role: "user", content: retryPrompt(problems) });
  }
  throw new KnownFailure(`scene3d_author_invalid: ${key(last[0] ?? "the scene failed the checks")} (${last.length} problem${last.length === 1 ? "" : "s"}, ${AUTHOR_MAX_ATTEMPTS} tries). Nothing was rendered. Run the author step again.`.slice(0, 600));
}
