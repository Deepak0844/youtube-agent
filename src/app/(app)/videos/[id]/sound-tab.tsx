import { forceRerunOffered, STAGE_LABELS } from "@/server/core/video-page-view";
import { BED_UNDER_VOICE_MAX_DB, BED_UNDER_VOICE_MIN_DB } from "@/server/core/sound-view";
import { getPool } from "@/server/db/pool";
import { loadSoundTab } from "@/server/db/sound-tab";
import type { VideoPage } from "@/server/db/video-page";
import { Pill } from "@/ui/primitives/pill";
import { ForceRerunForm } from "./controls";
import { BedPicker, EarOkForm } from "./sound-forms";

const H = ({ children }: { children: React.ReactNode }) => <h3 className="m-0 text-section font-medium">{children}</h3>;

// The Sound tab: the cue sheet, the music beds to audition and pick, the audibility check, and the owner's-ear tick. Read only except the two small forms.
export async function SoundTabPanel({ p }: { p: VideoPage }) {
  const s = await loadSoundTab(getPool(), p.head.id);
  const anyActive = Object.values(p.runStatus).some((r) => r === "queued" || r === "running" || r === "needs_decision");
  const rerun = forceRerunOffered("sfx", p.runStatus.sfx, p.head.status, anyActive, p.hasUpload);
  const verdict = new Map((s.verdicts ?? []).map((v) => [v.id, v]));
  return (
    <>
      <H>Sound plan</H>
      {s.rows.length === 0 ? <p data-testid="empty" className="m-0 max-w-[60ch] rounded-card bg-surface p-pad text-body text-muted">No sound plan for this video: it has narration only.</p> : (
        <table data-testid="cue-sheet" className="w-full max-w-2xl border-collapse text-left text-body">
          <thead><tr className="text-small text-muted"><th className="py-1 pr-3 font-normal">Time</th><th className="py-1 pr-3 font-normal">Kind</th><th className="py-1 pr-3 font-normal">Sound</th><th className="py-1 pr-3 font-normal">Level</th><th className="py-1 font-normal">Heard?</th></tr></thead>
          <tbody>
            {s.rows.map((r, i) => {
              const v = r.kind === "bed" ? verdict.get("bed") : undefined;
              return (
                <tr key={i} className="border-t border-rule align-top">
                  <td className="py-1 pr-3 tabular-nums">{r.atS === null ? "whole video" : `${r.atS.toFixed(2)} s`}</td>
                  <td className="py-1 pr-3">{r.kind === "bed" ? "Music bed" : r.optional ? "Sound (optional)" : "Sound"}</td>
                  <td className="py-1 pr-3 [overflow-wrap:anywhere]">{r.label}</td>
                  <td className="py-1 pr-3 tabular-nums">{r.levelDb.toFixed(1)} dB</td>
                  <td className="py-1">{v ? <Pill tone={v.audible ? "positive" : "warning"}>{v.audible ? "OK" : "Check"}</Pill> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Audibility s={s} />

      <H>Try every bed</H>
      {s.beds.length === 0 ? <p className="m-0 text-body text-muted">There are no music beds in the library yet.</p> : <BedPicker videoId={p.head.id} beds={s.beds} chosen={s.chosen} />}
      {s.stale ? <p data-testid="sound-stale" className="m-0 text-small text-pill-negative-ink">The music bed changed since the sound was mixed. Re-run {STAGE_LABELS.sfx} to hear it (free, local).</p> : null}
      {rerun ? <ForceRerunForm videoId={p.head.id} stage="sfx" label={STAGE_LABELS.sfx} hint="Mixes the sound again; the check runs again too." /> : null}

      <H>Your ear</H>
      <EarOkForm key={String(s.earOk)} videoId={p.head.id} done={s.earOk} />
      <p className="m-0 text-small text-muted">This is a record only. The video gate does not wait for it.</p>
    </>
  );
}

function Audibility({ s }: { s: Awaited<ReturnType<typeof loadSoundTab>> }) {
  if (s.verdicts === null) return <p className="m-0 text-small text-muted">The audibility check appears after the Sound step has run.</p>;
  const bad = s.verdicts.filter((v) => !v.audible);
  if (bad.length === 0) return <p data-testid="audibility" className="m-0 text-small text-pill-positive-ink">Audibility check: every sound can be heard against the voice.</p>;
  return (
    <p data-testid="audibility" className="m-0 text-small text-pill-negative-ink">
      Audibility check: {bad.map((v) => (v.id === "bed" ? `the music bed (should sit ${BED_UNDER_VOICE_MIN_DB} to ${BED_UNDER_VOICE_MAX_DB} dB under the voice)` : `cue ${v.id}`)).join("; ")} may not be heard well. Listen and adjust.
    </p>
  );
}
