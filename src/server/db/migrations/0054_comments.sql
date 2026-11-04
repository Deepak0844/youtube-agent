-- Phase 5 slice 5b: comment sync, drafted replies and posting. A comment's text is UNTRUSTED (anyone can write it); it is stored cleaned
-- and shown as plain text only. A reply never leaves this table by itself: only the owner's "Approve and post" moves it.
create table if not exists comments (
  id uuid primary key default gen_random_uuid(),
  youtube_comment_id text not null unique check (youtube_comment_id ~ '^[A-Za-z0-9_.-]{1,128}$'),
  video_id uuid not null references videos (id) on delete cascade,
  channel_id text not null,
  author_name text not null default '',
  text text not null,
  published_at timestamptz,
  status text not null default 'new' check (status in ('new', 'held', 'drafted', 'approved', 'posted', 'ignored', 'failed')),
  needs_eyes boolean not null default false,
  risk_reasons text[] not null default '{}',
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comments_video_idx on comments (video_id, published_at desc);
create index if not exists comments_status_idx on comments (status);

-- attempted_at is set when a post is tried (live) or rehearsed (dry); the daily cap and the gap between replies are counted from it,
-- with the database clock. mode says which kind of attempt it was.
create table if not exists comment_replies (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references comments (id) on delete cascade,
  draft_text text not null,
  status text not null default 'held' check (status in ('draft', 'held', 'approved', 'posted', 'failed', 'dry_run', 'ignored')),
  approved_by_session uuid,
  approved_hash text,
  approved_at timestamptz,
  attempted_at timestamptz,
  mode text check (mode in ('dry', 'live')),
  would_send jsonb,
  posted_youtube_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists comment_replies_comment_idx on comment_replies (comment_id);
-- at most one open reply per comment
create unique index if not exists comment_replies_open_uq on comment_replies (comment_id) where status in ('draft', 'held', 'approved', 'dry_run');

create table if not exists comment_sync_state (
  id int primary key default 1 check (id = 1),
  last_sync_at timestamptz
);
insert into comment_sync_state (id) values (1) on conflict do nothing;
