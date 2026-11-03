-- Phase 5 slice 2: safety switches per channel, and two global switches.
-- Defaults are the cautious ones: 2 uploads a day, 6 hours apart, "No, not made for kids" (always shown to the owner),
-- category 27 (Education). production and allow_public already exist (both false).
alter table youtube_channels
  add column if not exists max_uploads_per_day         integer not null default 2 check (max_uploads_per_day between 0 and 50),
  add column if not exists min_hours_between_uploads   integer not null default 6 check (min_hours_between_uploads between 0 and 168),
  add column if not exists default_language            text    not null default '' check (default_language ~ '^([a-z]{2,3}(-[A-Za-z0-9]{2,8})?)?$'),
  add column if not exists category_id                 integer not null default 27 check (category_id between 1 and 99),
  add column if not exists default_style               text check (default_style is null or default_style in
    ('clean_professional','flat_motion','minimal_diagram','premium_editorial','storybook_calm','paper_cutout','kinetic_type','retention_shorts','wrapped_stats','ai_studio')),
  add column if not exists synthetic_disclosure_default boolean not null default false;

-- Global switches (safety settings, owner session only): the kill switch refuses every upload; cutover_done must be true
-- before any channel marked production may receive an upload.
insert into settings (key, value, updated_by) values
  ('uploads.kill_switch', 'false', 'system'),
  ('youtube.cutover_done', 'false', 'system')
on conflict (key) do nothing;
