-- Spike C: exactly-once execution. Postgres is the source of truth; Redis/BullMQ is disposable.
-- Money is integer micro-USD (bigint). Ids are UUIDv7 generated in app code.

create table stage_runs (
  id uuid primary key,
  video_id uuid not null,
  name text not null,
  status text not null default 'queued'
    check (status in ('queued','running','succeeded','failed','needs_decision','cancelled')),
  input_hash text not null,
  fence bigint not null default 0,
  attempt_seq integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  attempt_job_id text,
  cancel_requested boolean not null default false,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Reconciler: find running stages whose lease expired.
create index stage_runs_status_lease_idx on stage_runs (status, lease_until);

create table spend_intents (
  id uuid primary key,
  stage_run_id uuid not null references stage_runs (id),
  step_index integer not null,
  tool_call_index integer not null,
  call_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending','done','failed_known','unknown')),
  reserved_micro_usd bigint not null default 0,
  actual_micro_usd bigint,
  provider_ref text,
  result jsonb,
  fence bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Reconciler: list a stage's intents (and FK lookups).
create index spend_intents_stage_run_idx on spend_intents (stage_run_id);

create table budgets (
  scope text primary key,
  cap_micro_usd bigint not null,
  reserved_micro_usd bigint not null default 0,
  spent_micro_usd bigint not null default 0
);

create table uploads (
  id uuid primary key,
  video_id uuid not null,
  status text not null
    check (status in ('publish_approved','uploading','uploaded','upload_failed')),
  approval_hash text,
  file_sha text,
  channel_id text,
  bytes_total bigint,
  bytes_sent bigint not null default 0,
  last_progress_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  youtube_id text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- "Is there already an active/finished upload for this video?" guard.
create index uploads_video_status_idx on uploads (video_id, status);
-- Schema-level no-double-upload: at most one uploading/uploaded row per video.
create unique index uploads_one_active_per_video on uploads (video_id) where status in ('uploading','uploaded');
-- Per-channel quota/window queries and stalled-upload sweeps.
create index uploads_channel_started_idx on uploads (channel_id, started_at);
create index uploads_status_progress_idx on uploads (status, last_progress_at);

create table upload_log (
  id bigserial primary key,
  upload_id uuid not null,
  at timestamptz not null default now(),
  event text not null
);
create index upload_log_upload_idx on upload_log (upload_id);
