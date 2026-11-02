-- The pictures stage records a hash of the beat's text + visual brief + search phrases on each link it makes, so a changed
-- script re-picks the picture. Null = a link made by hand (or before this column): the stage never touches those.
alter table video_assets add column if not exists brief_hash text;
