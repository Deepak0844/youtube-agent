-- Montage: the colour grade the owner picked for this video (null = the default, "film"). Plain column, nothing else changes.
alter table videos add column if not exists grade text check (grade in ('film', 'warm', 'cool', 'mono'));
