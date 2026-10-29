-- Uploaded and generated assets (Doc 13 4). One row per distinct original file: sha256 of the ORIGINAL bytes is unique,
-- so a second upload of the same bytes merges into this row instead of adding another. Files live under assets/<id>/
-- on the storage adapter; original_name is display metadata only and is never used to build a path.
create table assets (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('image', 'audio')),
  original_name text not null,
  mime text not null,
  bytes bigint not null check (bytes > 0),
  width int check (width is null or width > 0),
  height int check (height is null or height > 0),
  duration_s numeric check (duration_s is null or duration_s >= 0),
  sha256 text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_ref text not null,
  derived_refs jsonb not null default '{}',
  tags text[] not null default '{}',
  caption text,
  source text not null check (source in ('upload', 'generated', 'stock', 'found')),
  rights jsonb not null check (jsonb_typeof(rights -> 'attestations') = 'array' and jsonb_array_length(rights -> 'attestations') >= 1),
  keep boolean not null default false,
  created_by text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  purge_at timestamptz
);

-- Asset limits (Doc 13 9). Registry: src/server/core/settings-registry.ts. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('assets.max_image_bytes', '26214400', 'system'),
  ('assets.max_pixels', '50000000', 'system'),
  ('assets.max_batch_files', '100', 'system'),
  ('assets.total_bytes_cap', '5368709120', 'system')
on conflict (key) do nothing;
