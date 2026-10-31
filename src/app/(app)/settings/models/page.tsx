import { Suspense, type ReactNode } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import {
  PROVIDERS,
  STAGES,
  checkModelUsable,
  deriveEndpointKind,
  eligibleForStage,
  microToUsd,
  type ModelRow,
} from "@/server/core/llm-catalog";
import { claudeCodeStageFit } from "@/server/core/ai-source";
import { getClaudeCodeStatus, type ClaudeCodeStatus } from "@/server/db/claude-code";
import { getPool } from "@/server/db/pool";
import { listDefaults, listModels, listRoutes, localServices, modelsForStage, type CatalogDefault } from "@/server/db/llm-models";
import { Pill } from "@/ui/primitives/pill";
import { EmptyFrame } from "@/ui/domain/empty-frame";
import { getLastTests, type LastTest } from "@/server/db/llm-test";
import { LastTestLine } from "./last-test";
import { getEvalBadges } from "@/server/db/llm-eval";
import type { Badge } from "@/server/core/eval-rules";
import { EvalBadge } from "./eval-badge";
import { AiSourceForm, TestClaudeCodeButton } from "./ai-source";
import { EMPTY_MODEL, IdButton, ModelForm, RouteForm, TestModelButton, type ModelFormValues } from "./model-form";

// The model catalog is the owner's: ids and prices are data. Page and actions are session-only (requireOwner first).
// The Test button is a paid call for hosted models: it goes through the spend reservation, a daily cap and a cooldown (db/llm-test.ts).

export default function ModelsPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-64 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [models, routes, defaults, local, tests, badges, cc] = await Promise.all([listModels(db), listRoutes(db), listDefaults(db), localServices(db), getLastTests(db), getEvalBadges(db), getClaudeCodeStatus(db)]);
  return <Models models={models} routes={routes} defaults={defaults} local={local} tests={tests} badges={badges} cc={cc} />;
}

const usd = (micro: number) => `$${microToUsd(micro)}`;
const compact = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

function toValues(m: ModelRow): ModelFormValues {
  const p = m.prices;
  const f = (n: number | undefined) => (n === undefined ? "" : microToUsd(n));
  return {
    id: m.id,
    provider: m.provider,
    modelId: m.modelId,
    label: m.label,
    baseUrl: m.baseUrl ?? "",
    inputUsd: f(p?.inputPerMTokMicro),
    outputUsd: f(p?.outputPerMTokMicro),
    cacheWriteUsd: f(p?.cacheWritePerMTokMicro),
    cacheReadUsd: f(p?.cacheReadPerMTokMicro),
    reasoningUsd: f(p?.reasoningPerMTokMicro),
    perCallUsd: f(p?.perCallMicro),
    isFree: m.isFree,
    structuredOutput: m.capabilities.structuredOutput,
    toolUse: m.capabilities.toolUse,
    vision: m.capabilities.vision,
    nativeWebSearch: m.capabilities.nativeWebSearch,
    contextWindow: String(m.capabilities.contextWindow),
    enabled: m.enabled,
  };
}

function Caps({ m }: { m: ModelRow }) {
  const c = m.capabilities;
  const items: [string, boolean][] = [["JSON", c.structuredOutput], ["TOOLS", c.toolUse], ["VISION", c.vision], ["SEARCH", c.nativeWebSearch]];
  return (
    <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-small tracking-wide">
      {items.map(([name, on]) => (
        <span key={name} className={on ? "text-text" : "text-faint line-through"}>
          <span className="sr-only">{on ? "can: " : "cannot: "}</span>
          {name}
        </span>
      ))}
      <span className="text-muted">{compact(c.contextWindow)} ctx</span>
    </p>
  );
}

function Money({ m, local }: { m: ModelRow; local: string[] }) {
  const usable = checkModelUsable({ ...m, enabled: true }, local);
  if (m.isFree) {
    return usable.ok ? <span className="text-body">Free on this machine</span> : <span className="text-body text-negative">Free, but its address is no longer on the local list</span>;
  }
  if (!m.prices) return <span className="text-body text-negative">No price: refused for paid use</span>;
  return (
    <span className="font-mono text-body tabular-nums text-accent">
      {usd(m.prices.inputPerMTokMicro)} in / {usd(m.prices.outputPerMTokMicro)} out
      <span className="font-sans text-small text-faint"> per 1M tokens</span>
    </span>
  );
}

const LAST: Record<NonNullable<ClaudeCodeStatus["last"]>["result"], { text: string; ok: boolean }> = {
  ready: { text: "Ready", ok: true },
  not_found: { text: "Not found (not installed or not on PATH)", ok: false },
  not_logged_in: { text: "Not logged in", ok: false },
  limit_reached: { text: "Subscription limit reached", ok: false },
  failed: { text: "Did not finish cleanly", ok: false },
};
const WHEN = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });

/** The switch and the Claude Code status box. Everything here is read from the database: nothing is started on page load. */
function ClaudeCodeSection({ cc }: { cc: ClaudeCodeStatus }) {
  const fit = claudeCodeStageFit();
  const stays = fit.filter((f) => !f.ok);
  const notes = fit.filter((f) => f.ok && f.why);
  const rows: [string, ReactNode][] = [
    ["Claude Code", <Pill key="e" tone={cc.enabled ? "positive" : "neutral"}>{cc.enabled ? "Enabled" : "Disabled"}</Pill>],
    [
      "Last call",
      cc.last ? (
        <span key="l" className={LAST[cc.last.result].ok ? "text-positive" : "text-negative"}>
          {LAST[cc.last.result].text}
          <span className="text-faint"> · {WHEN.format(cc.last.at)} UTC</span>
        </span>
      ) : (
        <span key="l" className="text-faint">No call yet</span>
      ),
    ],
    ["Login the program reported", cc.last?.auth ?? <span key="a" className="text-faint">Not reported by the program</span>],
    ["Used today", <span key="u" className="font-mono tabular-nums">{cc.usedToday} of {cc.cap} calls (resets at midnight UTC)</span>],
    ["Cost recorded", <span key="c" className="font-mono tabular-nums">$0.00</span>],
    ["Tools", "Off (text only)"],
  ];
  return (
    <section aria-labelledby="source-h" className="flex flex-col gap-gap">
      <h2 id="source-h" className="text-title font-semibold">AI source</h2>
      <div className="flex flex-col gap-6 rounded-card bg-surface p-pad lg:grid lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <AiSourceForm on={cc.switchOn} />
          <div className="text-small text-muted">
            <p>Claude Code takes over the text stages it can do. You can still change any single stage below.</p>
            {stays.length > 0 ? (
              <ul className="mt-1 list-disc pl-5">
                {stays.map((s) => (
                  <li key={s.label}>{s.label} stays on its API model: it {s.why}, and Claude Code runs with tools off here.</li>
                ))}
                {notes.map((s) => (
                  <li key={s.label}>{s.label}: {s.why}</li>
                ))}
              </ul>
            ) : null}
            <p className="mt-1">If Claude Code is unavailable, those stages stop and wait for you. They never fall back to a paid API.</p>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <h3 className="text-section font-semibold">Claude Code status</h3>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-body">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted">{k}</dt>
                <dd className="min-w-0 [overflow-wrap:anywhere]">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-small text-warning">Log in to claude with your claude.ai subscription, not a Console API key: a key would bill the API while the books here say $0.</p>
          <TestClaudeCodeButton disabled={!cc.enabled} />
        </div>
      </div>
    </section>
  );
}

function Models({ models, routes, defaults, local, tests, badges, cc }: { models: ModelRow[]; routes: Record<string, string>; defaults: CatalogDefault[]; local: string[]; tests: Map<string, LastTest>; badges: Map<string, Badge>; cc: ClaudeCodeStatus }) {
  const providers = PROVIDERS.map((p) => ({ id: p.id, label: p.label }));
  const byId = new Map(models.map((m) => [m.id, m]));
  return (
    <div className="flex flex-col gap-layout pb-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-page-title font-semibold tracking-tight">Models</h1>
        <p className="max-w-[60ch] text-body text-muted">
          Your catalog and the model each stage uses. A stage runs on exactly one model; if it fails you see the error and choose again.
        </p>
      </header>

      <ClaudeCodeSection cc={cc} />

      <section aria-labelledby="routes-h" className="flex flex-col gap-gap">
        <h2 id="routes-h" className="text-title font-semibold">Stage routing</h2>
        <ul className="flex flex-col rounded-card bg-surface px-pad">
          {STAGES.map((s) => {
            const currentId = routes[s.id] ?? "";
            const current = byId.get(currentId);
            const options = modelsForStage(s.id, models, local).map(({ model }) => ({ id: model.id, label: model.label, detail: model.endpointKind === "local" ? "this machine" : model.provider }));
            const fit = current ? eligibleForStage(s.id, current) : undefined;
            const stale = current && (!checkModelUsable(current, local).ok || !fit?.ok);
            return (
              <li key={s.id} className="flex flex-col gap-2 border-b border-rule py-4 last:border-b-0 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:items-center lg:gap-6">
                <div className="min-w-0">
                  <h3 className="text-section font-semibold">{s.label}</h3>
                  <p className="text-small text-faint">{s.hint}</p>
                </div>
                <div className="flex min-w-0 flex-col gap-2">
                  <RouteForm stage={s.id} current={current && !stale ? currentId : ""} options={options} />
                  {stale ? <p className="text-small text-negative">The current model ({current.label}) can no longer do this stage. Choose another.</p> : null}
                  {fit?.ok ? fit.warnings.map((w) => <p key={w} className="text-small text-warning">{w}</p>) : null}
                  {!current && options.length === 0 ? <p className="text-small text-faint">No enabled model can do this yet.</p> : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="catalog-h" className="flex flex-col gap-gap">
        <h2 id="catalog-h" className="text-title font-semibold">Catalog</h2>
        {models.length === 0 ? (
          <EmptyFrame message="No models yet. Add one below, or copy a suggestion." />
        ) : (
          <ul className="flex flex-col rounded-card bg-surface px-pad">
            {models.map((m) => {
              const routed = Object.entries(routes).filter(([, id]) => id === m.id).map(([st]) => STAGES.find((s) => s.id === st)?.label ?? st);
              const kind = deriveEndpointKind(m.baseUrl, local);
              return (
                <li key={m.id} className="border-b border-rule py-4 last:border-b-0">
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h3 className="min-w-0 text-section font-semibold [overflow-wrap:anywhere]">{m.label}</h3>
                      <Pill tone={m.enabled ? "positive" : "neutral"}>{m.enabled ? "Enabled" : "Disabled"}</Pill>
                      <Pill tone={kind === "local" ? "neutral" : "warning"}>{kind === "local" ? "This machine" : "Hosted"}</Pill>
                    </div>
                    <p className="font-mono text-small text-muted [overflow-wrap:anywhere]">
                      {m.provider} / {m.modelId}
                      {m.baseUrl ? ` @ ${m.baseUrl}` : ""}
                    </p>
                    <Money m={m} local={local} />
                    <Caps m={m} />
                    {routed.length > 0 ? <p className="text-small text-muted">Used by: {routed.join(", ")}</p> : null}
                    {m.isFree || m.prices ? <TestModelButton id={m.id} label={m.label} free={m.isFree} /> : <p className="text-small text-faint">Add a price to test this model.</p>}
                    <LastTestLine test={tests.get(m.id)} />
                    <EvalBadge badge={badges.get(m.id)} />
                  </div>
                  <details className="group mt-3">
                    <summary className="inline-flex min-h-11 cursor-pointer items-center text-body font-medium text-text underline underline-offset-4 sm:min-h-9">Edit {m.label}</summary>
                    <div className="mt-3 flex flex-col gap-6">
                      <ModelForm values={toValues(m)} providers={providers} submitLabel="Save changes" />
                      <div className="border-t border-rule pt-4">
                        {routed.length > 0 ? (
                          <p className="text-small text-faint">This model is used by a stage. Change that route before deleting it.</p>
                        ) : (
                          <IdButton kind="delete" id={m.id} label={`Delete ${m.label}`} variant="destructive" />
                        )}
                      </div>
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="add-h" className="rounded-card bg-surface p-pad">
        <details>
          <summary id="add-h" className="flex min-h-11 cursor-pointer items-center text-title font-semibold">Add a model</summary>
          <div className="mt-4">
            <ModelForm values={EMPTY_MODEL} providers={providers} submitLabel="Add model" />
          </div>
        </details>
      </section>

      <section aria-labelledby="sug-h" className="flex flex-col gap-gap">
        <h2 id="sug-h" className="text-title font-semibold">Suggestions</h2>
        <p className="max-w-[60ch] text-small text-faint">
          Read-only starting points. Copying makes your own editable entry. Hosted ones arrive disabled and without a price: type the current price from the provider page.
        </p>
        <ul className="flex flex-col rounded-card bg-surface px-pad">
          {defaults.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 border-b border-rule py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-body font-medium [overflow-wrap:anywhere]">{d.label}</p>
                <p className="font-mono text-small text-muted [overflow-wrap:anywhere]">{d.provider} / {d.modelId}</p>
                <p className="max-w-[60ch] text-small text-faint">{d.note}{d.priceAsOf ? ` Price as of ${d.priceAsOf}.` : ""}</p>
              </div>
              <IdButton kind="copy" id={d.id} label="Copy to my catalog" />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
