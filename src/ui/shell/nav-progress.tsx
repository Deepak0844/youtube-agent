"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Thin progress bar for page changes (UI redesign: smooth transitions). It starts when an in-app link is clicked and
 * finishes when the new path or query arrives. Purely visual; aria-hidden. Reduced motion only drops the easing.
 */
export function NavProgress() {
  const path = usePathname();
  const query = useSearchParams().toString();
  const [state, setState] = useState<"idle" | "running" | "done">("idle");
  const started = useRef(false);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest("a") : null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      started.current = true;
      setState("running");
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!started.current) return;
    started.current = false;
    setState("done");
    const t = setTimeout(() => setState("idle"), 350);
    return () => clearTimeout(t);
  }, [path, query]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden">
      <div
        className="h-full bg-text transition-[width,opacity] ease-out motion-reduce:transition-none"
        style={{
          width: state === "idle" ? "0%" : state === "running" ? "80%" : "100%",
          opacity: state === "done" ? 0 : 1,
          transitionDuration: state === "running" ? "2500ms" : "300ms",
        }}
      />
    </div>
  );
}
