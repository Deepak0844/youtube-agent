-- Phase 8: AI video providers. A new registry kind 'video'; rows start OFF and unpriced ('{}' is refused): the owner switches a
-- provider on, saves its key and types the per-second price copied from its public pricing page. No number is typed here.
alter table media_providers drop constraint if exists media_providers_kind_check;
alter table media_providers add constraint media_providers_kind_check check (kind in ('voice', 'music', 'sfx', 'image', 'stock', 'video'));
insert into media_providers (id, kind, label, word_timings, local, price) values
  ('seedance_video', 'video', 'Seedance video (BytePlus)', null, false, '{}')
on conflict (id) do nothing;
