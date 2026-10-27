-- Phase 2 pipeline tables: a video and its versioned content. No foreign key from stage_runs.video_id on purpose
-- (Spike C tests insert free-standing ids). Content is append-only by convention: new version = new row.
create table videos (
  id uuid primary key default gen_random_uuid(),
  format text not null check (format in ('short', 'long')),
  kind text not null check (kind in ('scene_kit', 'tsx', 'collage', 'ai')),
  language text not null check (language in ('en', 'hi', 'ta', 'te', 'ml', 'kn')),
  topic text not null,
  notes text,
  channel_id text,
  status text not null default 'active' check (status in ('active', 'waiting', 'done', 'failed', 'cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table video_content (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos (id) on delete cascade,
  kind text not null check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration')),
  version int not null check (version >= 1),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  body jsonb,
  file_path text,
  produced_by uuid,
  created_at timestamptz not null default now(),
  unique (video_id, kind, version),
  constraint video_content_one_source check ((body is null) <> (file_path is null)),
  -- bodies over 256 KB must be files
  constraint video_content_body_size check (body is null or pg_column_size(body) <= 262144)
);
