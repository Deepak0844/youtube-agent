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
    <main className="grid min-h-dvh flex-1 bg-ground lg:grid-cols-[minmax(0,1fr)_minmax(26rem,32rem)]">
      <div className="flex flex-col justify-between gap-16 px-4 py-5 sm:px-gutter lg:py-8">
        <div className="flex items-center gap-2 text-body font-semibold tracking-tight text-text">
          <Mark />
          YT Studio
        </div>
        <div className="hidden flex-col gap-10 lg:flex">
          <p className="max-w-[14ch] text-[clamp(2.25rem,4.6vw,4rem)] leading-[1.02] font-semibold tracking-tight text-text">
            Nothing goes out until you say so.
          </p>
          <Strip />
        </div>
      </div>
      <div className="flex items-center justify-center px-4 pb-10 sm:px-gutter lg:py-10 lg:pr-gutter lg:pl-0">
        <section className="flex w-full max-w-md flex-col gap-6 rounded-frame border border-border bg-page p-6 shadow-sm sm:p-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-page-title font-semibold tracking-tight text-text">{title}</h1>
            <p className="text-body text-muted">{lead}</p>
          </div>
          {children}
        </section>
      </div>
    </main>
  );
}
