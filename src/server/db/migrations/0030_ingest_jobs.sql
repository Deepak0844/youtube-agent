-- Upload ingest jobs (Doc 13 5). One row per file sent to /api/uploads: the web process writes it, the worker's ingest
-- job finishes it. Postgres decides what runs (queued -> running is a one-shot claim); Redis only delivers.
-- original_name is display metadata only. The spooled file lives at <root>/assets-incoming/<id>; no path comes from input.
-- `bytes` is the declared size while receiving, the real size once queued, and 0 when rejected (it counts toward the storage cap).
create table ingest_jobs (
  id uuid primary key,
  batch_id uuid not null,
  status text not null check (status in ('receiving', 'queued', 'running', 'done', 'rejected')),
  kind text check (kind in ('image', 'audio')),
  original_name text not null,
  bytes bigint not null default 0 check (bytes >= 0),
  tags text[] not null default '{}',
  caption text,
  keep boolean not null default false,
  contains_person boolean not null,
  voice_clone boolean not null,
  rights jsonb not null,
  asset_id uuid references assets(id),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ingest_jobs_batch_idx on ingest_jobs (batch_id);
create index ingest_jobs_created_idx on ingest_jobs (created_at);

-- One limit set only: the old uploads.* keys were unsafe duplicates (safety = false) of the assets.* limits.
delete from settings where key in ('uploads.max_image_mb', 'uploads.max_image_mp', 'uploads.total_gb');
insert into settings (key, value, updated_by) values ('assets.max_audio_bytes', '209715200', 'system') on conflict (key) do nothing;
