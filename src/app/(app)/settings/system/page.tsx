import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { localServiceBlockers, MAX_LOCAL_SERVICES } from "@/server/core/local-services";
import { getPool } from "@/server/db/pool";
import { loadSystemSettings } from "@/server/db/system-settings";
import { getSystemStatus, type SystemStatus } from "@/server/db/system-status";
import { Pill } from "@/ui/primitives/pill";
import { LimitsForm, LocalServicesForm } from "./forms";

// Reads the session (cookies) and live server facts, so everything sits inside <Suspense> with a static frame.
export default function SystemSettings() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [status, view] = await Promise.all([getSystemStatus(db), loadSystemSettings(db)]);
  const { renders, jobs, warnGb, longMinutes, services } = view;
  const blockers = localServiceBlockers();
  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <h1 className="text-page-title font-semibold tracking-tight">System</h1>
      <Status s={status} />
      <section aria-labelledby="limits-h" className="rounded-card bg-surface p-pad">
        <h2 id="limits-h" className="text-title font-semibold">Limits</h2>
        <p className="mt-1 mb-5 text-body text-muted">How much the studio does at once, and how long a video may run.</p>
        <LimitsForm
          renders={renders}
          jobs={jobs}
          warnGb={warnGb}
          longMinutes={longMinutes}
          sceneKit={view.sceneKit}
          tracksLater={["Code scenes (Phase 4)", "Collage (Phase 8)", "AI video (Phase 9)"]}
        />
      </section>
      <section aria-labelledby="local-h" className="rounded-card bg-surface p-pad">
        <h2 id="local-h" className="text-title font-semibold">Local services</h2>
        <p className="mt-1 mb-5 max-w-[60ch] text-body text-muted">
          Programs on this machine or your network that you type addresses for, such as Ollama or LM Studio. An address that is
          local is only reachable if it is listed here. The studio&apos;s own services (database, Redis, search, renderer, fetcher)
          and cloud metadata addresses can never be listed. Changes are written to the audit log.
        </p>
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
    <section aria-labelledby="status-h" className="rounded-card bg-surface p-pad">
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
        <Row label="Storage folder"><code className="font-mono text-small text-muted">{s.disk.root}</code></Row>
        <Row label="Versions">
          <span className="font-mono text-small text-muted tabular-nums">
            app {s.versions.app} · node {s.versions.node} · next {s.versions.next} · postgres {s.versions.postgres ?? "?"}
          </span>
        </Row>
      </dl>
    </section>
  );
}
