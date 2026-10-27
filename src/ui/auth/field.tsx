import type { ComponentProps } from "react";
import { Input } from "../primitives/input";
import { Label } from "../primitives/label";

// Label above the control, always visible (never a placeholder). 44 px tall at every width: these pages are used on phones.
export function Field({ label, id, ...input }: { label: string; id: string } & Omit<ComponentProps<"input">, "id">) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-body text-text">
        {label}
      </Label>
      <Input id={id} className="sm:min-h-11" {...input} />
    </div>
  );
}
