-- Phase 2 Task 12: in-app notifications, a delivery log, and the notify settings seed (registry: core/settings-registry.ts).
-- notifications is the owner-facing record (bell + list): it is always written, whatever the other channels do.
-- The unique index is the "fire once per transition" guard: a worker redelivery inserts nothing. video_id may be null
-- (backup failed, Google login expired), so it is coalesced to the nil uuid in the index.
create table if not exists notifications (
  id bigserial primary key,
  at timestamptz not null default now(),
  event text not null,
  video_id uuid,
  to_state text not null,
  transition_id text not null,
  title text not null,
  text text not null default '',
  read_at timestamptz
);
create unique index if not exists notifications_once_per_transition
  on notifications (event, coalesce(video_id, '00000000-0000-0000-0000-000000000000'::uuid), to_state, transition_id);
create index if not exists notifications_unread on notifications (at desc) where read_at is null;

-- One row per channel attempt. Append-only for the app role. `error` holds an error class name only, never a message.
create table if not exists notification_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  notification_id bigint not null references notifications (id) on delete cascade,
  channel text not null check (channel in ('desktop', 'webhook')),
  status text not null check (status in ('sent', 'failed', 'held')),
  error text
);
create index if not exists notification_log_by_notification on notification_log (notification_id);
revoke update, delete, truncate on notification_log from ytstudio_app;

insert into settings (key, value, updated_by) values
  ('notify.master', 'true', 'system'),
  ('notify.quiet_hours', '{"enabled":false,"start":"22:00","end":"07:00","tz":"Asia/Kolkata"}', 'system'),
  ('notify.events', '{"outline_review":{"in_app":true,"desktop":true,"webhook":false},"script_review":{"in_app":true,"desktop":true,"webhook":false},"cost_approval":{"in_app":true,"desktop":true,"webhook":false},"chapter_ready":{"in_app":true,"desktop":true,"webhook":false},"video_review":{"in_app":true,"desktop":true,"webhook":false},"evidence_signoff":{"in_app":true,"desktop":true,"webhook":false},"publish_approval":{"in_app":true,"desktop":true,"webhook":false},"comment_replies":{"in_app":true,"desktop":true,"webhook":false},"needs_decision":{"in_app":true,"desktop":true,"webhook":false},"video_failed":{"in_app":true,"desktop":true,"webhook":false},"video_blocked":{"in_app":true,"desktop":true,"webhook":false},"upload_failed":{"in_app":true,"desktop":true,"webhook":false},"spend_cap_hit":{"in_app":true,"desktop":true,"webhook":false},"google_login_expired":{"in_app":true,"desktop":true,"webhook":false},"run_failed":{"in_app":true,"desktop":true,"webhook":false},"backup_failed":{"in_app":true,"desktop":true,"webhook":false},"drafting_paused":{"in_app":true,"desktop":true,"webhook":false},"uploaded_private":{"in_app":true,"desktop":false,"webhook":false},"scheduled_release_done":{"in_app":true,"desktop":false,"webhook":false},"weekly_review_ready":{"in_app":true,"desktop":false,"webhook":false}}', 'system')
on conflict (key) do nothing;
-- notify.events must equal DEFAULT_EVENT_SWITCHES in core/notify.ts (checked by tests/integration/settings.test.ts).
