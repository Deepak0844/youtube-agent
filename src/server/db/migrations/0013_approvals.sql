-- Hash-bound gate decisions (Doc 02 4.4). Append-only for the app role: an approval is never edited or removed, a newer
-- decision supersedes it, and it only counts while its content_hash equals the live hash (derived in code, see db/approvals.ts).
create table approvals (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  video_id uuid not null references videos (id) on delete cascade,
  gate text not null check (gate in ('outline','script','cost','chapter','video','thumbnail','evidence','publish','comment_reply','allow_public','live_title')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('approved', 'sent_back')),
  note text check (note is null or char_length(note) <= 1000),
  decided_at timestamptz not null default clock_timestamp(),
  decided_by text not null check (decided_by = 'session'),
  constraint approvals_sent_back_needs_note check (decision <> 'sent_back' or char_length(btrim(coalesce(note, ''))) >= 3)
);
create unique index approvals_seq_idx on approvals (seq);
create index approvals_latest_idx on approvals (video_id, gate, seq desc);
revoke update, delete, truncate on approvals from ytstudio_app;
