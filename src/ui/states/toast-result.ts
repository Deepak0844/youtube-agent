"use client";

import { toast } from "sonner";

/** One toast for every save / approve / retry result (spec §4.6.6). */
export function toastResult(r: { ok: true; message?: string } | { ok: false; message: string }, okText: string): void {
  if (r.ok) toast.success(r.message ?? okText);
  else toast.error(r.message);
}
