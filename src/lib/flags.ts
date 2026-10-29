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
  // Not built yet (later phases).
  library: false,
  new: false,
  assets: false,
  ideas: false, // Phase 6
  series: false, // Phase 6b
  "plan.calendar": false,
  "plan.research": false,
  "plan.targets": false,
  "publish.uploads": false,
  "publish.engagement": false,
  "publish.analytics": false,
  "settings.account": false,
  "settings.providers": false,
  "settings.tokens": false,
  "settings.channels": false,
    "settings.assets": false,
  "settings.policies": false,
  "settings.notifications": false,
  "settings.schedule": false, // Phase 6
  "settings.health": false,
};

export function isEnabled(flag: string): boolean {
  return FLAGS[flag] === true;
}
