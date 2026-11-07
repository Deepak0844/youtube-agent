-- Phase 7: where the webhook notification channel posts. Empty = none. Registry: core/settings-registry.ts (safety key, session-only).
insert into settings (key, value, updated_by) values
  ('notify.webhook_url', '""', 'system')
on conflict (key) do nothing;
