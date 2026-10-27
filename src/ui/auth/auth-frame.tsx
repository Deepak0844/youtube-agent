import type { ReactNode } from "react";
import { Mark } from "../shell/mark";

// Public pages (sign in, first-time setup) have no app shell. Two tonal fields on one screen: a black "studio" side that
// shows the Cut strip big (the product's signature, with the Review stage held), and a #111 panel that holds the form.
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
            <span className={`font-mono text-small ${held ? "text-text" : "text-faint"}`}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function AuthFrame({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  return (
    <main className="grid min-h-dvh flex-1 grid-rows-[auto_1fr] lg:grid-rows-1 lg:grid-cols-[minmax(0,1fr)_minmax(26rem,32rem)]">
      <div className="flex flex-col justify-between gap-16 px-4 py-5 sm:px-gutter lg:py-8">
        <div className="flex items-center gap-2 font-mono text-body font-medium tracking-tight text-text">
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
      <section className="flex flex-col justify-center gap-6 bg-surface px-4 py-10 sm:px-gutter lg:px-12">
        <div className="flex flex-col gap-1">
          <h1 className="text-page-title font-semibold tracking-tight text-text">{title}</h1>
          <p className="text-body text-muted">{lead}</p>
        </div>
        {children}
      </section>
    </main>
  );
}
