-- Stock clips (pictures stage): a short licensed video is an asset of kind 'video'. Uploads still take only image and audio
-- (ingest_jobs.kind is unchanged); only the pictures stage registers a clip, after the sandboxed ffprobe check.
alter table assets drop constraint assets_kind_check;
alter table assets add constraint assets_kind_check check (kind in ('image', 'audio', 'video'));
