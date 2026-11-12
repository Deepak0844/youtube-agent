"use client";

import Link from "next/link";
import type * as React from "react";
import { markReadOnOpenAction } from "@/app/_actions/notifications";

/** A bell row that opens its video: marks the message read and closes the bell panel on the way. */
export function BellLink({ id, unread, href, className, children }: { id: string; unread: boolean; href: string; className?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        e.currentTarget.closest("details")?.removeAttribute("open");
        if (unread) void markReadOnOpenAction(id).catch(() => undefined);
      }}
    >
      {children}
    </Link>
  );
}
