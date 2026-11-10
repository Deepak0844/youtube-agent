-- Phase 6b slice 4: a short derived from a long video. `derived_from` (0072) names the long video; these two columns say which run of its scenes
-- (zero-based, inclusive) the short is made from. Both or neither; a derived video is always a short, and a video with `derived_from` always has
-- a range. A derived video keeps its range even if the long video is later deleted (derived_from then becomes null), so it is still known to be
-- derived and never falls back to the paid Draft route.
alter table videos add column if not exists derive_from_scene integer;
alter table videos add column if not exists derive_to_scene integer;
alter table videos drop constraint if exists videos_derive_both_check;
alter table videos add constraint videos_derive_both_check check ((derive_from_scene is null) = (derive_to_scene is null));
alter table videos drop constraint if exists videos_derive_range_check;
alter table videos add constraint videos_derive_range_check check (derive_from_scene is null or (derive_from_scene >= 0 and derive_to_scene >= derive_from_scene and format = 'short'));
alter table videos drop constraint if exists videos_derive_source_check;
alter table videos add constraint videos_derive_source_check check (derived_from is null or derive_from_scene is not null);
