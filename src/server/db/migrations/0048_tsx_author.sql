-- Phase 4 TSX slice 3: the accepted model-written scene file is stored as content kind `tsx` (versioned, hash-bound), and a
-- video that fell back from the code-scene path to the scene kit remembers what it was asked to be. Only widens a check and
-- adds a nullable column; no data changes. `kind_origin` keeps the video's parameters hash (and so every earlier stage's
-- hash and the owner's script approval) the same after the fall-back.
alter table video_content drop constraint if exists video_content_kind_check;
alter table video_content add constraint video_content_kind_check
  check (kind in ('script', 'beats', 'evidence', 'cost_plan', 'video', 'metadata', 'titles', 'narration', 'captions', 'scenes', 'tsx'));
alter table videos add column if not exists kind_origin text check (kind_origin is null or kind_origin = 'tsx');
