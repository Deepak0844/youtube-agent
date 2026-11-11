"use client";

import * as React from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../primitives/tooltip";

/**
 * A control that cannot be used says why (spec §4.6.8): the reason is the child's accessible description and shows on
 * hover/focus. Disabled buttons get no pointer events, so the tooltip hangs on a focusable wrapper.
 */
export function WithReason({ reason, children }: { reason: string | null; children: React.ReactElement<{ "aria-describedby"?: string }> }) {
  const id = React.useId();
  if (!reason) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex rounded-control">
          {React.cloneElement(children, { "aria-describedby": id })}
          <span id={id} className="sr-only">
            {reason}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
