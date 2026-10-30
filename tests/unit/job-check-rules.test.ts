import { describe, expect, it } from "vitest";
import { checkMessage } from "@/server/core/job-check-rules";

describe("checkMessage", () => {
  it("says_plain_words_for_every_outcome_and_never_leaks_internals", () => {
    for (const o of ["done", "running", "failed", "unknown", "already_done", "nothing_to_check"] as const) {
      const m = checkMessage(o);
      expect(m.length).toBeGreaterThan(20);
      expect(m).not.toMatch(/intent|reservation|fence|call_key|media_jobs/i);
    }
    expect(checkMessage("failed")).toMatch(/nothing was released/i);
    expect(checkMessage("unknown")).toMatch(/nothing was released/i);
  });
});
