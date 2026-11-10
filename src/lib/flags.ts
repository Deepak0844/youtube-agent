// Feature flags: one static map, no runtime source. A page that is not built yet is off, so the nav never links to it.
// Turning a flag on is part of the change that adds the page (Doc 4 §1: items marked † stay off until Phases 6/6b).
export const FLAGS: Record<string, boolean> = {
  home: true,
  // Built in Phase 1.
  "settings.models": true,
  "settings.keys": true,
  "settings.google": true,
  "settings.audit": true,
  "settings.system": true,
  // Phase 2.
  queue: true,
  "settings.budgets": true,
  assets: true,
  library: true,
  new: true,
  "settings.providers": true,
  "settings.assets": true,
  // Not built yet (later phases).
  ideas: true, // Phase 6.3
  series: true, // Phase 6b.1
  "plan.calendar": true, // Phase 6.7
  "plan.research": true, // Phase 6.4
  "plan.targets": true, // Phase 6
  "publish.uploads": false,
  "publish.engagement": true, // Phase 5 slice 5b
  "publish.analytics": true, // Phase 5 slice 5a
  "settings.account": true, // Phase 9 parity
  "settings.tokens": true,
  "settings.channels": true,
  "settings.policies": true, // Phase 9 parity
  "settings.notifications": true, // Phase 7
  "settings.schedule": true, // Phase 6
  "settings.health": false,
};

export function isEnabled(flag: string): boolean {
  return FLAGS[flag] === true;
}
