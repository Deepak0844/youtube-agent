import { Suspense } from "react";
import { requireOwner } from "@/lib/auth/require-owner";
import { SCOPE_LABELS, canRoute, priceLabel } from "@/server/core/media-catalog";
import { listProviders, listRoutes } from "@/server/db/media-registry";
import { classifyAddress } from "@/server/core/net-policy";
import { loadLocalServices, loadVoiceServers } from "@/server/db/system-settings";
import { hostPortOf } from "@/server/providers/voice/endpoints";
import { getPool } from "@/server/db/pool";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/ui/primitives/table";
import { ProviderList, type ProviderView } from "./provider-table";
import { RouteForm } from "./route-form";
import { VoiceServers, type VoiceServerView } from "./voice-servers";

// Media providers (voice, music, sound effects, images, stock) and which one each kind of video uses.
// requireOwner() reads the cookie (request-time data), so it runs inside <Suspense> (cacheComponents).
export default function ProvidersPage() {
  return (
    <Suspense fallback={<div aria-hidden className="h-96 rounded-card bg-surface" />}>
      <Owned />
    </Suspense>
  );
}

const KINDS = [
  ["voice", "Voice"],
  ["music", "Music"],
  ["sfx", "Sound effects"],
  ["image", "Images"],
  ["stock", "Stock media"],
] as const;
const COMMERCIAL = { yes: "Commercial use allowed.", no: "Commercial use not allowed.", unknown: "Commercial use not confirmed." } as const;

async function Owned() {
  await requireOwner();
  const db = getPool();
  const [providers, routes, voice, services] = await Promise.all([listProviders(db), listRoutes(db), loadVoiceServers(db), loadLocalServices(db)]);
  // A local or private address only works when its host:port is on the list; a public host needs no entry.
  const missing = (value: string): string | null => {
    const hp = hostPortOf(value);
    if (!hp || services.includes(hp)) return null;
    const host = hp.slice(0, hp.lastIndexOf(":")).replace(/^\[|\]$/g, "");
    return host === "localhost" || ["private", "loopback", "cgnat", "docker"].includes(classifyAddress(host)) ? hp : null;
  };
  const voiceItems: VoiceServerView[] = [
    { field: "voicestudio_url", label: "VoiceStudio address", placeholder: "http://127.0.0.1:3900", value: voice.voicestudio_url, missing: missing(voice.voicestudio_url),
      help: "Same computer: use http://127.0.0.1:PORT, no key needed. Another computer needs https and a key. Leave empty to turn it off." },
    { field: "local_url", label: "Local OpenAI-compatible voice address", placeholder: "http://127.0.0.1:8880", value: voice.local_url, missing: missing(voice.local_url),
      help: "A voice server on this computer that speaks the OpenAI voice format. Same rules: this computer needs no key, another one needs https and a key." },
    { field: "azure_region", label: "Azure region", placeholder: "westeurope", value: voice.azure_region, missing: null,
      help: "The Azure Speech region your key belongs to, for example westeurope or eastus. Letters, digits and hyphens only." },
  ];
  const label = new Map(providers.map((p) => [p.id, p.label]));
  const free = (p: { price: unknown }) => priceLabel(p.price) === "free";

  return (
    <div className="flex min-w-0 flex-col gap-layout">
      <header>
        <h1 className="text-page-title font-semibold tracking-tight">Providers</h1>
        <p className="mt-2 max-w-prose text-body text-muted">
          Who makes the voice, music, sound effects and images. A paid provider needs its key on the Keys page before it can be switched on. A provider
          whose price is not set cannot be chosen below. Prices are for a typical short and are estimates. Every change is written to the audit log.
        </p>
      </header>

      <section aria-labelledby="voice-servers-h" className="flex flex-col gap-gap rounded-card bg-surface p-pad">
        <h2 id="voice-servers-h" className="text-title font-semibold">Voice servers</h2>
        <p className="max-w-[60ch] text-body text-muted">
          Where the voice providers below are reached. A server on this computer must also be listed under System &gt; Local services,
          which you can do from here. Changes are written to the audit log.
        </p>
        <VoiceServers items={voiceItems} />
      </section>

      {KINDS.map(([kind, title]) => (
        <section key={kind} aria-labelledby={`k-${kind}`} className="flex flex-col gap-gap">
          <h2 id={`k-${kind}`} className="text-small font-semibold tracking-wide text-faint uppercase">
            {title}
          </h2>
          <ProviderList
            providers={providers
              .filter((p) => p.kind === kind)
              .map(
                (p): ProviderView => ({
                  id: p.id,
                  label: p.label,
                  enabled: p.enabled,
                  keyStatus: p.hasKey ? "saved" : free(p) || p.local ? "not needed" : "missing",
                  languages: p.languages.join(", "),
                  timing: kind === "voice" ? (p.wordTimings && p.wordTimings !== "none" ? p.wordTimings : "estimated") : null,
                  price: priceLabel(p.price),
                  commercial: COMMERCIAL[p.commercialUse as keyof typeof COMMERCIAL] ?? COMMERCIAL.unknown,
                }),
              )}
          />
        </section>
      ))}

      <section aria-labelledby="routes-h" className="flex flex-col gap-gap rounded-card bg-surface p-pad">
        <h2 id="routes-h" className="text-title font-semibold">Who is used for what</h2>
        {routes.length === 0 ? (
          <p className="text-body text-muted">Nothing is chosen yet. Videos that need one of these will wait until you choose.</p>
        ) : (
          <Table data-testid="route-table">
            <TableHeader>
              <TableRow>
                <TableHead>Kind</TableHead>
                <TableHead>Used for</TableHead>
                <TableHead>Provider</TableHead>
                <TableHead>Narration voice</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((r) => (
                <TableRow key={`${r.kind}-${r.scope}`}>
                  <TableCell>{KINDS.find(([k]) => k === r.kind)?.[1] ?? r.kind}</TableCell>
                  <TableCell>{SCOPE_LABELS[r.scope] ?? r.scope}</TableCell>
                  <TableCell>{label.get(r.provider) ?? r.provider}</TableCell>
                  <TableCell>{r.voice ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <RouteForm
          providers={providers.filter((p) => canRoute(p).ok).map((p) => ({ id: p.id, label: `${p.label} (${p.kind})` }))}
          scopes={Object.entries(SCOPE_LABELS).map(([id, l]) => ({ id, label: l }))}
        />
      </section>
    </div>
  );
}
