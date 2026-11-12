import { getPool } from "@/server/db/pool";
import { listTitleTests } from "@/server/db/title-tests-list";

const VERDICT = { a_better: "Title A did better", b_better: "Title B did better", no_conclusion: "No clear winner" } as const;

// Read only: title tests are planned and recorded elsewhere. Sequential windows, so a result is a hint, not proof.
export async function TitleTests() {
  const tests = await listTitleTests(getPool());
  return (
    <section aria-labelledby="tt-h" className="flex min-w-0 flex-col gap-3">
      <h2 id="tt-h" className="text-title font-semibold">Title tests</h2>
      {tests.length === 0 ? (
        <p className="rounded-card border border-border bg-surface p-pad text-body text-muted">No title tests yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {tests.map((t) => (
            <li key={t.id} data-testid="title-test-row" className="flex min-w-0 flex-col gap-1 rounded-card border border-border bg-surface p-pad text-body [overflow-wrap:anywhere]">
              <span className="font-medium">{t.topic}</span>
              <span className="text-muted">A: {t.titleA}</span>
              <span className="text-muted">B: {t.titleB}</span>
              <span>{t.result ? `${VERDICT[t.result.verdict]}. ${t.result.note}` : `Status: ${t.status}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
