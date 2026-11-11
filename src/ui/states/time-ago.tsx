"use client";

import { useEffect, useState } from "react";
import { formatIst } from "@/server/core/display-format";
import { ageLabel } from "@/server/core/videos-view";

/** "2 h ago" with the exact IST time on hover (spec §4.6.10). `live` refreshes the words every 10 s. */
export function TimeAgo({ at, live = false, prefix }: { at: Date; live?: boolean; prefix?: string }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, [live]);
  return (
    <time dateTime={at.toISOString()} title={formatIst(at)} suppressHydrationWarning>
      {prefix}
      {ageLabel(at, now)}
    </time>
  );
}
