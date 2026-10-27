-- Phase 2 Task 11: live feed events. Postgres is the truth; Redis only wakes listeners up.
-- Append-only for the app role. The only delete path is prune_events() (SECURITY DEFINER, owned by the migration role),
-- which removes rows older than 7 days. No foreign keys: a feed row may outlive the video or stage it names.
create table if not exists events (
  id bigserial primary key,
  at timestamptz not null default now(),
  video_id uuid,
  stage_run_id uuid,
  type text not null check (type in (
    'stage.started', 'stage.succeeded', 'stage.failed', 'stage.needs_decision', 'stage.cancelled',
    'gate.waiting', 'gate.approved', 'gate.sent_back',
    'video.created', 'video.done', 'video.failed',
    'log', 'notify'
  )),
  payload jsonb not null default '{}'::jsonb,
  constraint events_payload_size check (octet_length(payload::text) <= 4096)
);
create index if not exists events_at on events (at);
create index if not exists events_by_video on events (video_id, id);
revoke update, delete, truncate on events from ytstudio_app;

create or replace function prune_events() returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n bigint;
begin
  delete from events where at < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function prune_events() from public;
grant execute on function prune_events() to ytstudio_app;
