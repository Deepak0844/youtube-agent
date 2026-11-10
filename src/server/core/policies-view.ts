// What the Policies page shows: the conditions that must ALL hold before anything is published publicly. Pure: no IO.
// Public publishing is deliberately hard to reach: this global switch, the channel's own switch, the kill switch off, and the go-live cutover.

export interface PublicRequirement {
  label: string;
  /** true = met, false = not met, null = decided per channel (no single answer here) */
  ok: boolean | null;
  /** where to change it */
  where: string;
  href: string;
}

export function publicRequirements(s: { allowPublic: boolean; killSwitch: boolean; cutoverDone: boolean }): PublicRequirement[] {
  return [
    { label: "Public publishing is allowed here (the switch on this page)", ok: s.allowPublic, where: "This page", href: "/settings/policies" },
    { label: "The channel allows public videos (set per channel, and approved at its own gate)", ok: null, where: "Channels", href: "/settings/channels" },
    { label: "The upload kill switch is off", ok: !s.killSwitch, where: "System", href: "/settings/system" },
    { label: "The go-live cutover is done (production channels only)", ok: s.cutoverDone, where: "System", href: "/settings/system" },
  ];
}

/** One plain sentence for the top of the page. */
export function publicSummary(s: { allowPublic: boolean; killSwitch: boolean; cutoverDone: boolean }): string {
  if (s.killSwitch) return "Every upload is stopped right now (the kill switch is on).";
  if (!s.allowPublic) return "Videos upload as private or unlisted only. Nothing can be made public.";
  return s.cutoverDone ? "Public publishing is allowed, for channels that allow it. Each publish still needs your approval." : "Public publishing is allowed, but production channels stay locked until the go-live cutover is done.";
}
