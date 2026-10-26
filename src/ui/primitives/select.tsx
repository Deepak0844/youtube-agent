import * as React from "react";
import * as S from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import { cn, control, fade, focusRing } from "../lib/cn";

export const Select = S.Root;
export const SelectValue = S.Value;
export const SelectTrigger = ({ className, children, ...p }: React.ComponentProps<typeof S.Trigger>) => (
  <S.Trigger
    className={cn(
      "inline-flex w-full items-center justify-between gap-2 rounded-control border border-control bg-surface px-4 text-body text-text data-[placeholder]:text-faint disabled:opacity-50",
      control,
      fade,
      focusRing,
      className,
    )}
    {...p}
  >
    {children}
    <S.Icon>
      <ChevronDown size={14} aria-hidden />
    </S.Icon>
  </S.Trigger>
);
export const SelectContent = ({ className, children, ...p }: React.ComponentProps<typeof S.Content>) => (
  <S.Portal>
    <S.Content
      position="popper"
      sideOffset={6}
      className={cn("z-50 min-w-(--radix-select-trigger-width) rounded-card bg-raised p-1.5 text-text", className)}
      {...p}
    >
      <S.Viewport>{children}</S.Viewport>
    </S.Content>
  </S.Portal>
);
export const SelectItem = ({ className, children, ...p }: React.ComponentProps<typeof S.Item>) => (
  <S.Item
    className={cn(
      "flex min-h-11 cursor-default items-center justify-between gap-3 rounded-control px-3 text-body data-[highlighted]:bg-control data-[highlighted]:outline-none sm:min-h-9",
      className,
    )}
    {...p}
  >
    <S.ItemText>{children}</S.ItemText>
    <S.ItemIndicator>
      <Check size={14} aria-hidden />
    </S.ItemIndicator>
  </S.Item>
);
