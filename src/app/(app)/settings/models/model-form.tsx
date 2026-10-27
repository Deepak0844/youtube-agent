"use client";

import { useActionState, type ReactNode } from "react";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { cn, control, focusRing } from "@/ui/lib/cn";
import { copyDefaultAction, deleteModelAction, saveModelAction, setRouteAction, type FormState } from "./actions";

// Plain forms on purpose: they work before hydration and on a phone keyboard. Values are never echoed back from the server
// beyond what the owner typed; there are no secrets on this page.

export interface ProviderOption {
  id: string;
  label: string;
}
export interface ModelFormValues {
  id: string;
  provider: string;
  modelId: string;
  label: string;
  baseUrl: string;
  inputUsd: string;
  outputUsd: string;
  cacheWriteUsd: string;
  cacheReadUsd: string;
  reasoningUsd: string;
  perCallUsd: string;
  isFree: boolean;
  structuredOutput: boolean;
  toolUse: boolean;
  vision: boolean;
  nativeWebSearch: boolean;
  contextWindow: string;
  enabled: boolean;
}
export const EMPTY_MODEL: ModelFormValues = {
  id: "",
  provider: "anthropic",
  modelId: "",
  label: "",
  baseUrl: "",
  inputUsd: "",
  outputUsd: "",
  cacheWriteUsd: "",
  cacheReadUsd: "",
  reasoningUsd: "",
  perCallUsd: "",
  isFree: false,
  structuredOutput: true,
  toolUse: false,
  vision: false,
  nativeWebSearch: false,
  contextWindow: "128000",
  enabled: false,
};

const idle: FormState = {};

function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <span className="text-small font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-small text-faint">{hint}</span> : null}
    </label>
  );
}

function Check({ name, label, defaultChecked, hint }: { name: string; label: string; defaultChecked: boolean; hint?: string }) {
  return (
    <label className="flex min-h-11 items-start gap-3 py-2 sm:min-h-9">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className={cn("mt-0.5 size-5 shrink-0 accent-accent", focusRing)} />
      <span className="text-body">
        {label}
        {hint ? <span className="block text-small text-faint">{hint}</span> : null}
      </span>
    </label>
  );
}

const selectClass = cn("w-full rounded-control border border-control bg-surface px-4 text-body text-text", control, focusRing);

export function ModelForm({ values: saved, providers, submitLabel }: { values: ModelFormValues; providers: ProviderOption[]; submitLabel: string }) {
  const [state, action, pending] = useActionState(saveModelAction, idle);
  // After a refused save the form shows what was typed (React resets uncontrolled fields to their default after an action).
  const f = state.fields;
  const values: ModelFormValues = f
    ? {
        ...saved,
        ...(Object.fromEntries(Object.keys(EMPTY_MODEL).filter((k) => typeof EMPTY_MODEL[k as keyof ModelFormValues] === "string" && k !== "id").map((k) => [k, f[k] ?? ""])) as Partial<ModelFormValues>),
        isFree: f.isFree === "on",
        structuredOutput: f.structuredOutput === "on",
        toolUse: f.toolUse === "on",
        vision: f.vision === "on",
        nativeWebSearch: f.nativeWebSearch === "on",
        enabled: f.enabled === "on",
      }
    : saved;
  return (
    <form action={action} className="flex flex-col gap-5" aria-label={values.id ? `Edit ${values.label}` : "Add a model"}>
      <input type="hidden" name="rowId" value={values.id} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider">
          <select name="provider" defaultValue={values.provider} className={selectClass}>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model id" hint="Exactly as the provider names it.">
          <Input name="modelId" required maxLength={200} defaultValue={values.modelId} autoCapitalize="none" autoCorrect="off" spellCheck={false} className="font-mono" />
        </Field>
        <Field label="Name in this app">
          <Input name="label" required maxLength={100} defaultValue={values.label} />
        </Field>
        <Field label="Base URL" hint="Needed for Ollama, LM Studio and custom endpoints. Leave empty for the provider's own address.">
          <Input name="baseUrl" type="url" maxLength={300} defaultValue={values.baseUrl} placeholder="http://localhost:11434/v1" autoCapitalize="none" spellCheck={false} className="font-mono" />
        </Field>
      </div>

      <fieldset className="flex flex-col gap-3 border-t border-rule pt-4">
        <legend className="mb-1 pr-3 text-small font-medium text-muted">Price in dollars per million tokens</legend>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Field label="Input">
            <Input name="inputUsd" inputMode="decimal" defaultValue={values.inputUsd} placeholder="3.00" className="tabular-nums" />
          </Field>
          <Field label="Output">
            <Input name="outputUsd" inputMode="decimal" defaultValue={values.outputUsd} placeholder="15.00" className="tabular-nums" />
          </Field>
          <Field label="Per call, optional" hint="Web search and similar.">
            <Input name="perCallUsd" inputMode="decimal" defaultValue={values.perCallUsd} className="tabular-nums" />
          </Field>
          <Field label="Cache write, optional">
            <Input name="cacheWriteUsd" inputMode="decimal" defaultValue={values.cacheWriteUsd} className="tabular-nums" />
          </Field>
          <Field label="Cache read, optional">
            <Input name="cacheReadUsd" inputMode="decimal" defaultValue={values.cacheReadUsd} className="tabular-nums" />
          </Field>
          <Field label="Thinking, optional">
            <Input name="reasoningUsd" inputMode="decimal" defaultValue={values.reasoningUsd} className="tabular-nums" />
          </Field>
        </div>
        <p className="text-small text-faint">A model with no price is refused for paid use, and cannot be enabled.</p>
        <Check
          name="isFree"
          label="Free: runs on this machine"
          defaultChecked={values.isFree}
          hint="Accepted only when the base URL is this machine, or an address on the local-service list. Prices are then ignored."
        />
      </fieldset>

      <fieldset className="flex flex-col gap-1 border-t border-rule pt-4">
        <legend className="mb-1 pr-3 text-small font-medium text-muted">What the model can do</legend>
        <div className="grid sm:grid-cols-2">
          <Check name="structuredOutput" label="Structured output (JSON)" defaultChecked={values.structuredOutput} />
          <Check name="toolUse" label="Tool use" defaultChecked={values.toolUse} />
          <Check name="vision" label="Image input" defaultChecked={values.vision} />
          <Check name="nativeWebSearch" label="Native web search" defaultChecked={values.nativeWebSearch} />
        </div>
        <Field label="Context window (tokens)" className="mt-2 max-w-48">
          <Input name="contextWindow" inputMode="numeric" required defaultValue={values.contextWindow} className="tabular-nums" />
        </Field>
      </fieldset>

      <div className="border-t border-rule pt-2">
        <Check name="enabled" label="Enabled" defaultChecked={values.enabled} hint="Only an enabled model with a price (or free on this machine) can be used for a stage." />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving" : submitLabel}
        </Button>
        <p role="status" aria-live="polite" className={cn("text-body", state.error ? "text-negative" : "text-positive")}>
          {state.error ?? (state.ok ? "Saved." : "")}
        </p>
      </div>
    </form>
  );
}

/** One stage. The select lists only models that can do the stage; "Not set" clears it. */
export function RouteForm({
  stage,
  current,
  options,
}: {
  stage: string;
  current: string;
  options: { id: string; label: string; detail: string }[];
}) {
  const [state, action, pending] = useActionState(setRouteAction, idle);
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input type="hidden" name="stage" value={stage} />
      <select name="modelId" defaultValue={current} aria-label={`Model for ${stage}`} className={cn(selectClass, "sm:max-w-80")}>
        <option value="">Not set</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label} ({o.detail})
          </option>
        ))}
      </select>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving" : "Use"}
      </Button>
      <p role="status" aria-live="polite" className={cn("text-small", state.error ? "text-negative" : "text-positive")}>
        {state.error ?? (state.ok ? "Saved." : "")}
      </p>
    </form>
  );
}

/** A button-only form for copy and delete. */
export function IdButton({ kind, id, label, variant = "secondary" }: { kind: "copy" | "delete"; id: string; label: string; variant?: "secondary" | "destructive" }) {
  const [state, action, pending] = useActionState(kind === "copy" ? copyDefaultAction : deleteModelAction, idle);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="rowId" value={id} />
      <Button type="submit" variant={variant} disabled={pending}>
        {label}
      </Button>
      <p role="status" aria-live="polite" className={cn("text-small", state.error ? "text-negative" : "text-positive")}>
        {state.error ?? (state.ok ? "Done." : "")}
      </p>
    </form>
  );
}
