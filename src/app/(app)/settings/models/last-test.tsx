import type { LastTest } from "@/server/db/llm-test";

// What the last Test said, read back from the database (fixed sentences and numbers only; never an answer or a provider body).

const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

export function LastTestLine({ test }: { test: LastTest | undefined }) {
  if (!test) return <p className="text-small text-faint">Not tested yet.</p>;
  return (
    <p className="text-small text-muted">
      <span className={test.ok ? "text-positive" : "text-negative"}>{test.ok ? "Last test passed" : "Last test failed"}</span>
      <span className="text-faint"> · {WHEN.format(test.at)} UTC</span>
      <span> · {test.message}</span>
    </p>
  );
}
