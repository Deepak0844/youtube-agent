import { Suspense } from "react";
import { PageSkeleton } from "@/ui/states/page-skeleton";
import { requireOwner } from "@/lib/auth/require-owner";
import { localServiceBlockers, MAX_LOCAL_SERVICES, ownServiceConfigProblem } from "@/server/core/local-services";
import { getPool } from "@/server/db/pool";
import { checkNativeRenderReady } from "@/server/providers/renderer/native-preflight";
import { loadInrRate, loadSystemSettings } from "@/server/db/system-settings";
import { getSystemStatus, type SystemStatus } from "@/server/db/system-status";
import { Pill } from "@/ui/primitives/pill";
import { EngineNumbersSection } from "./engine-numbers-section";
import { RateForm } from "./rate-form";
import { RunNowForms } from "./run-now";
import { BackupSection } from "./backup-section";
import { CutoverForm, KillSwitchForm, LimitsForm, LocalServicesForm } from "./forms";

export const metadata = { title: "System" };

// Reads the session (cookies) and live server facts, so everything sits inside <Suspense> with a static frame.
export default function SystemSettings() {
  return (
    <Suspense fallback={<PageSkeleton variant="form" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [status, view] = await Promise.all([getSystemStatus(db), loadSystemSettings(db)]);
  const { renders, jobs, warnGb, longMinutes, services } = view;
  const nativeStatus = (await checkNativeRenderReady({ storageRoot: status.disk.root })).message;
  const blockers = localServiceBlockers();
  const configProblem = ownServiceConfigProblem();
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <h1 className="text-page-title font-semibold tracking-tight">System</h1>
      <Status s={status} />
      <BackupSection />
      <RateForm rate={await loadInrRate(db)} />
      <section aria-labelledby="limits-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="limits-h" className="text-title font-semibold">Limits</h2>
        <p className="mt-1 mb-5 text-body text-muted">How much the studio does at once, and how long a video may run.</p>
        <LimitsForm
          renders={renders}
          jobs={jobs}
          warnGb={warnGb}
          longMinutes={longMinutes}
          renderTimeoutS={view.renderTimeoutS}
          native3d={view.native3d}
          nativeTimeoutS={view.nativeTimeoutS}
          nativeStatus={nativeStatus}
          sceneKit={view.sceneKit}
          tracksLater={["Code scenes (Phase 4)", "Collage (Phase 8)", "AI video (Phase 9)"]}
        />
      </section>
      <EngineNumbersSection />
      <section aria-labelledby="uploads-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="uploads-h" className="text-title font-semibold">Uploads to YouTube</h2>
        <p className="mt-1 mb-5 max-w-[60ch] text-body text-muted">
          The kill switch refuses every upload, now and when an approved one is about to start. Until the go-live cutover is done,
          no channel marked Production receives an upload. Google may force uploads from an unaudited app to private, whatever is
          chosen. Every change is written to the audit log.
        </p>
        <div className="flex flex-col gap-6">
          <KillSwitchForm on={view.killSwitch} />
          <CutoverForm done={view.cutoverDone} />
        </div>
      </section>
      <section aria-labelledby="local-h" className="rounded-card border border-border bg-surface p-pad">
        <h2 id="local-h" className="text-title font-semibold">Local services</h2>
        <p className="mt-1 mb-5 max-w-[60ch] text-body text-muted">
          Programs on this machine or your network that you type addresses for, such as Ollama or LM Studio. An address that is
          local is only reachable if it is listed here. The studio&apos;s own services (database, Redis, search, renderer, fetcher)
          and cloud metadata addresses can never be listed. Changes are written to the audit log.
        </p>
        {configProblem ? (
          <p role="note" className="mb-5 max-w-[60ch] rounded-card bg-pill-negative-bg p-4 text-body text-pill-negative-ink">
            {configProblem}
          </p>
        ) : null}
        {blockers.length > 0 ? (
          <p role="note" className="mb-5 max-w-[60ch] rounded-card bg-pill-warning-bg p-4 text-body text-pill-warning-ink">
            Local services are switched off. The server is missing these settings, so the studio cannot tell which ports are its
            own: {blockers.join(", ")}. Set them, restart, and the list below takes effect.
          </p>
        ) : null}
        <LocalServicesForm entries={services} max={MAX_LOCAL_SERVICES} />
      </section>
    </div>
  );
}

const GB = 1024 ** 3;
const gb = (n: number) => `${(n / GB).toFixed(1)} GB`;

const VAULT: Record<SystemStatus["vault"]["status"], { tone: "positive" | "warning" | "negative"; label: string }> = {
  ok: { tone: "positive", label: "Unlocked" },
  missing_key: { tone: "warning", label: "No master key loaded" },
  wrong_key: { tone: "negative", label: "Wrong master key" },
  unreadable: { tone: "negative", label: "Some keys unreadable" },
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-rule py-2 last:border-b-0">
      <dt className="text-body text-muted">{label}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-body [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

function Up({ ok, ms }: { ok: boolean; ms: number | null }) {
  return (
    <>
      {ok && ms !== null ? <span className="text-small text-faint tabular-nums">{ms} ms</span> : null}
      <Pill tone={ok ? "positive" : "negative"}>{ok ? "Reachable" : "Down"}</Pill>
    </>
  );
}

function Status({ s }: { s: SystemStatus }) {
  const v = VAULT[s.vault.status];
  const used = s.disk.totalBytes > 0 ? 1 - s.disk.freeBytes / s.disk.totalBytes : 0;
  return (
    <section aria-labelledby="status-h" className="rounded-card border border-border bg-surface p-pad">
      <h2 id="status-h" className="text-title font-semibold">Status</h2>
      <p className="mt-1 mb-3 text-body text-muted">Read only. No keys or addresses are shown here.</p>
      <dl>
        <Row label="Database"><Up ok={s.db.ok} ms={s.db.ms} /></Row>
        <Row label="Redis"><Up ok={s.redis.ok} ms={s.redis.ms} /></Row>
        <Row label="Key vault"><Pill tone={v.tone}>{v.label}</Pill></Row>
        <Row label="Disk free">
          <span className="tabular-nums">{gb(s.disk.freeBytes)}</span>
          <span className="text-small text-faint tabular-nums">of {gb(s.disk.totalBytes)}</span>
          <Pill tone={used > 0.9 ? "warning" : "neutral"}>{Math.round(used * 100)}% used</Pill>
        </Row>
        <Row label="CPU load"><span className="tabular-nums">{Math.round(s.cpuLoad * 100)}%</span></Row>
        <Row label="Memory">
          <span className="tabular-nums">{gb(s.memory.usedBytes)}</span>
          <span className="text-small text-faint tabular-nums">of {gb(s.memory.totalBytes)}</span>
        </Row>
        <Row label="Job queue">
          {s.queue ? (
            <span className="tabular-nums">{s.queue.waiting} waiting · {s.queue.active} active · {s.queue.failed} failed</span>
          ) : (
            <Pill tone="negative">Unknown (Redis down)</Pill>
          )}
        </Row>
        {s.tools.map((t) => (
          <Row key={t.id} label={t.label}>
            <Pill tone={t.ok ? "positive" : "negative"}>{t.ok ? "Ready" : "Needs attention"}</Pill>
            <span data-testid={`tool-${t.id}`} className="text-small text-muted">{t.detail}{t.fix ? ` ${t.fix}` : ""}</span>
          </Row>
        ))}
        <Row label="Storage used">
          <span className="tabular-nums">{s.storageBytes === null ? "Unknown" : gb(s.storageBytes)}</span>
          <span className="text-small text-faint">estimate, refreshed each minute</span>
        </Row>
        <Row label="Storage folder"><code className="font-mono text-small text-muted">{s.disk.root}</code></Row>
        <Row label="Versions">
          <span className="font-mono text-small text-muted tabular-nums">
            app {s.versions.app} · node {s.versions.node} · next {s.versions.next} · postgres {s.versions.postgres ?? "?"}
          </span>
        </Row>
      </dl>
      <h3 className="mt-5 mb-2 text-body font-semibold">Run now</h3>
      <RunNowForms />
    </section>
  );
}
