-- Per-video look. Null means the default look (clean_pro), so every existing video is unchanged.
-- caption_style is a separate, optional layer on top of any style. The app validates the values; no check here so adding a style needs no migration.
alter table videos add column if not exists style text;
alter table videos add column if not exists caption_style text;
