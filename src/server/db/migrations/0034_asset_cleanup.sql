-- Asset clean-up settings (Doc 13 4). Registry: src/server/core/settings-registry.ts. Reseeding never overwrites an edit.
insert into settings (key, value, updated_by) values
  ('assets.retention_days', '7', 'system'),
  ('assets.unused_days', '30', 'system'),
  ('assets.trash_days', '7', 'system')
on conflict (key) do nothing;

-- A purged asset must not be blocked by the upload jobs that created it: the job history stays, without the link.
alter table ingest_jobs drop constraint ingest_jobs_asset_id_fkey;
alter table ingest_jobs add constraint ingest_jobs_asset_id_fkey foreign key (asset_id) references assets(id) on delete set null;
