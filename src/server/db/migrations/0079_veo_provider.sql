-- Phase 8.4: the Veo (Google Cloud Vertex AI) video provider row. Off and unpriced ('{}' is refused) until the owner switches it on,
-- saves the service-account file and types the per-second price for the model they use.
insert into media_providers (id, kind, label, word_timings, local, price) values
  ('veo_video', 'video', 'Veo video (Google Cloud)', null, false, '{}')
on conflict (id) do nothing;
