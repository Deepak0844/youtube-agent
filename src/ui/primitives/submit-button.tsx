"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonProps } from "./button";

/** A form's submit button: spinner + disabled while the form's action runs, so a double click cannot send twice. */
export function SubmitButton({ loading, ...props }: Omit<ButtonProps, "type" | "asChild">) {
  const { pending } = useFormStatus();
  return <Button type="submit" loading={pending || loading} {...props} />;
}
