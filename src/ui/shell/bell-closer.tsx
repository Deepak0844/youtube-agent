"use client";

import { useEffect, useRef } from "react";

/** Closes the bell panel (its <details>) on a click outside it or on Escape. Renders nothing. */
export function BellCloser() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const details = ref.current?.closest("details");
    if (!details) return;
    const onPointer = (e: PointerEvent) => {
      if (details.open && e.target instanceof Node && !details.contains(e.target)) details.open = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && details.open) {
        details.open = false;
        details.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return <span ref={ref} hidden />;
}
