import { ENGINE_NUMBER_FIELDS } from "@/server/core/engine-numbers";
import { SETTINGS } from "@/server/core/settings-registry";
import { getPool } from "@/server/db/pool";
import { loadEngineNumbers } from "@/server/db/system-settings";
import { EngineNumbersForm, type EngineNumberRow } from "./engine-numbers-form";

const show = (v: unknown) => [v].flat().join(", ");

// Server part: reads the saved engine numbers; the owner has already been checked by the page.
export async function EngineNumbersSection() {
  const saved = await loadEngineNumbers(getPool());
  const rows: EngineNumberRow[] = ENGINE_NUMBER_FIELDS.map((f) => ({ ...f, def: show(SETTINGS[f.key].default), current: show(saved[f.key]) }));
  return (
    <section aria-labelledby="engine-h" className="rounded-card border border-border bg-surface p-pad">
      <h2 id="engine-h" className="text-title font-semibold">Engine numbers</h2>
      <p className="mt-1 mb-5 max-w-[60ch] text-body text-muted">
        Retries, time limits, the circuit breaker and the video quality checks. Wrong values can make stages fail or let bad
        videos through, so each has a range and Reset puts back the default. Changes apply to the next stage and are written to the audit log.
      </p>
      <EngineNumbersForm rows={rows} />
    </section>
  );
}
