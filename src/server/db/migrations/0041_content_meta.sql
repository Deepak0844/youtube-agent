-- Phase 4: optional notes on a content version (which scenes a repair changed, which version an undo copied). Not hashed.
alter table video_content add column if not exists meta jsonb;
