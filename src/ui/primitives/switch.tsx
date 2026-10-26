import * as React from "react";
import * as S from "@radix-ui/react-switch";
import { cn, fade, focusRing } from "../lib/cn";

/** Visual track 24 px; on phone an invisible pseudo-element grows the hit area to 44 px. */
export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-control bg-raised p-0.5 data-[state=checked]:bg-text disabled:opacity-50",
        "before:absolute before:-inset-2.5 before:content-[''] sm:before:hidden",
        fade,
        focusRing,
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-5 rounded-control bg-muted transition-transform duration-150 motion-reduce:transition-none data-[state=checked]:translate-x-5 data-[state=checked]:bg-ground" />
    </S.Root>
  );
}
