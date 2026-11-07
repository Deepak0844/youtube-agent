-- Phase 6: per-channel ideas and language. An idea can belong to one connected channel (kept if the channel row goes: set null).
-- The channel description is untrusted text read from YouTube; it is length limited here too and only ever sent to a model as fenced data.
alter table ideas add column if not exists channel_id text references youtube_channels (channel_id) on delete set null;
create index if not exists ideas_channel_status_idx on ideas (channel_id, status);

alter table youtube_channels add column if not exists description text not null default '' check (char_length(description) <= 5000);
alter table youtube_channels add column if not exists description_fetched_at timestamptz;
