-- Phase 8.3: the Kling AI video provider row. Off and unpriced ('{}' is refused) until the owner switches it on, saves a key and types the price.
insert into media_providers (id, kind, label, word_timings, local, price) values
  ('kling_video', 'video', 'Kling video', null, false, '{}')
on conflict (id) do nothing;
