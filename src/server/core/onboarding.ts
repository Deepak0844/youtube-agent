// First-run setup (Doc 4 "/onboarding"): which of the five steps are done, worked out from real saved state. Pure, no I/O.
export interface OnboardingFacts {
  /** A language-model key is saved in the vault. */
  llmKeySaved: boolean;
  /** At least one pipeline stage has a model chosen. */
  modelChosen: boolean;
  googleAppSaved: boolean;
  /** A channel is linked and not waiting to be reconnected. */
  channelConnected: boolean;
  /** The vault opens with the loaded master key. */
  vaultReadable: boolean;
}

export type StepId = "keys" | "models" | "google" | "channel" | "dryrun";
export interface Step {
  id: StepId;
  title: string;
  done: boolean;
  /** One plain sentence: what this step is and what is missing. */
  text: string;
  href: string;
  cta: string;
}
export interface DryRunCheck { label: string; ok: boolean }

export function dryRunChecks(f: OnboardingFacts): DryRunCheck[] {
  return [
    { label: "The vault opens with your master key", ok: f.vaultReadable },
    { label: "A language-model key is saved", ok: f.llmKeySaved },
    { label: "Models are chosen for the pipeline stages", ok: f.modelChosen },
    { label: "Your Google app is saved", ok: f.googleAppSaved },
    { label: "A YouTube channel is connected", ok: f.channelConnected },
  ];
}

export function onboardingSteps(f: OnboardingFacts): Step[] {
  const first: Step[] = [
    { id: "keys", title: "Add a key", done: f.llmKeySaved, href: "/settings/keys", cta: f.llmKeySaved ? "Review keys" : "Add a key",
      text: f.llmKeySaved ? "A language-model key is saved." : "Paste an API key from the company whose AI writes your scripts. You type it; nothing is filled in for you." },
    { id: "models", title: "Choose models", done: f.modelChosen, href: "/settings/models", cta: f.modelChosen ? "Review models" : "Choose models",
      text: f.modelChosen ? "Models are chosen." : "Pick which model handles each step of making a video." },
    { id: "google", title: "Save your Google app", done: f.googleAppSaved, href: "/settings/google", cta: f.googleAppSaved ? "Review Google app" : "Set up Google app",
      text: f.googleAppSaved ? "Your Google app is saved." : "Your own Google Cloud app is how channels are connected." },
    { id: "channel", title: "Connect a channel", done: f.channelConnected, href: "/settings/channels", cta: f.channelConnected ? "Review channels" : "Connect a channel",
      text: f.channelConnected ? "A channel is connected." : "Sign in with Google and pick the YouTube channel to use." },
  ];
  const ready = first.every((s) => s.done) && f.vaultReadable;
  return [...first, {
    id: "dryrun", title: "Check readiness", done: ready, href: "/onboarding#dryrun", cta: "Review",
    text: ready ? "Everything needed is in place. This check only reads settings: no paid calls, no uploads, nothing published." : "Finish the steps above first. This check only reads settings: no paid calls, no uploads, nothing published.",
  }];
}

/** True while any of the four setup steps is open; drives the first-run link on Home. */
export const setupIncomplete = (f: OnboardingFacts): boolean => !(f.llmKeySaved && f.modelChosen && f.googleAppSaved && f.channelConnected);
