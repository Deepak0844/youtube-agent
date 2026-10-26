import * as React from "react";
import * as T from "@radix-ui/react-tabs";
import { cn, fade, focusRing } from "../lib/cn";

export const Tabs = T.Root;
export const TabsContent = ({ className, ...p }: React.ComponentProps<typeof T.Content>) => (
  <T.Content className={cn(focusRing, className)} {...p} />
);
export const TabsList = ({ className, ...p }: React.ComponentProps<typeof T.List>) => (
  <T.List className={cn("flex gap-5 border-b border-rule", className)} {...p} />
);
/** Active tab is marked by a text-coloured underline plus brighter text, not colour alone. */
export const TabsTrigger = ({ className, ...p }: React.ComponentProps<typeof T.Trigger>) => (
  <T.Trigger
    className={cn(
      "-mb-px min-h-11 border-b-2 border-transparent text-body text-muted data-[state=active]:border-text data-[state=active]:text-text sm:min-h-9",
      fade,
      focusRing,
      className,
    )}
    {...p}
  />
);
