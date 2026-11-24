-- Cartoon series (owner 2026-11-24): the cast a cartoon video was started with. A part copies its series' current cast here when it starts, and the build reads THIS
-- copy, never the live series value, so clearing the series cast while an episode is being built does not change that episode. Null = no cast yet.
alter table videos add column if not exists cast_snapshot jsonb;
