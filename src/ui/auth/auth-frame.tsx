import type { ReactNode } from "react";
import { Mark } from "../shell/mark";

// Public pages (sign in, first-time setup) have no app shell. The grey ground carries the wordmark and the stage strip;
// the form sits on a framed card (UI redesign, both themes).
// On a phone only the wordmark row stays above the form. The decorative strip is hidden from assistive tech.
const STAGES = ["Draft", "Build", "Voice", "Render", "Sound", "Check", "Review", "Publish"] as const;
const HELD = "Review";

function Strip() {
  return (
    <ol aria-hidden className="grid grid-cols-8 gap-2">
      {STAGES.map((s, i) => {
        const held = s === HELD;
        const before = i < STAGES.indexOf(HELD);
        return (
          <li key={s} className="flex flex-col gap-2">
            <span className="flex h-14 items-end">
              <span className={held ? "h-14 w-full rounded-md border-2 border-text" : `h-8 w-full rounded-md bg-text ${before ? "" : "opacity-40"}`} />
            </span>
            <span className={`text-small ${held ? "text-text" : "text-faint"}`}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function AuthFrame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    // Brand on top, the form centred in the free space below it, and (desktop) the headline with the stage strip along the
    // bottom. The form never covers the headline: it centres in the space that is left, so short windows just scroll.
    <main className="flex min-h-dvh flex-1 flex-col gap-10 bg-ground px-4 py-5 sm:px-gutter lg:py-8">
      <div className="flex items-center gap-2 text-body font-semibold tracking-tight text-text">
        <Mark />
        YT Studio
      </div>
      <div className="flex flex-1 items-center justify-center">
        <section className="flex w-full max-w-md flex-col gap-6 rounded-frame border border-border bg-page p-6 sm:p-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-page-title font-semibold tracking-tight text-text">{title}</h1>
            <p className="text-body text-muted">{lead}</p>
          </div>
          {children}
        </section>
      </div>
      <div className="hidden flex-col gap-10 lg:flex">
        <p className="max-w-[14ch] text-[clamp(2.25rem,4.6vw,4rem)] leading-[1.02] font-semibold tracking-tight text-text">
          Nothing goes out until you say so.
        </p>
        <Strip />
      </div>
    </main>
  );
}
