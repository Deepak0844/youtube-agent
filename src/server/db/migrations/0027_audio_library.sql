-- Audio library with provenance (Phase 3 Task 11). One row per distinct file (sha256 unique). A row with no licence
-- text is refused here as well as in code (Doc 10: block unlicensed). used_in is a JSON array of video ids.
create table audio_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('sfx', 'music')),
  name text not null,
  tags text[] not null default '{}',
  source text not null check (source in ('shipped', 'owned', 'generated', 'upload')),
  licence text not null check (btrim(licence) <> ''),
  provenance jsonb not null,
  file_path text not null,
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  duration_s numeric check (duration_s is null or duration_s >= 0),
  mean_lufs numeric,
  peak_dbfs numeric,
  used_in jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index audio_items_kind_idx on audio_items (kind);
