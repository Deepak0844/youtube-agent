-- Hash-bound gate decisions (Doc 02 4.4). Append-only for the app role: an approval is never edited or removed, a newer
-- decision supersedes it, and it only counts while its content_hash equals the live hash (derived in code, see db/approvals.ts).
create table approvals (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  -- restrict: a video with decisions cannot be deleted, so the app role cannot erase the ledger through the video row.
  video_id uuid not null references videos (id) on delete restrict,
  gate text not null check (gate in ('outline','script','cost','chapter','video','thumbnail','evidence','publish','comment_reply','allow_public','live_title')),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- the exact video_content rows (kind -> {id, version}) the hash was computed from, read in one snapshot
  content_versions jsonb not null,
  decision text not null check (decision in ('approved', 'sent_back')),
  note text check (note is null or char_length(note) <= 1000),
  decided_at timestamptz not null default clock_timestamp(),
  decided_by text not null check (decided_by = 'session'),
  session_id uuid not null, -- the signed-in session that made the decision (no FK: sessions expire)
  constraint approvals_sent_back_needs_note check (decision <> 'sent_back' or char_length(btrim(coalesce(note, ''))) >= 3)
);
create unique index approvals_seq_idx on approvals (seq);
create index approvals_latest_idx on approvals (video_id, gate, seq desc);

-- Ordering and time are decided by the database, never by the caller: OVERRIDING SYSTEM VALUE or an explicit decided_at
-- cannot pin a forged row as "newest". SECURITY DEFINER so the app role needs no right on the sequence.
create function approvals_force_order() returns trigger
language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  new.seq := nextval(pg_get_serial_sequence('public.approvals', 'seq'));
  new.decided_at := clock_timestamp();
  return new;
end $$;
revoke all on function approvals_force_order() from public;
create trigger approvals_force_order before insert on approvals for each row execute function approvals_force_order();

revoke update, delete, truncate on approvals from ytstudio_app;
-- The app cannot move the sequence (setval) either.
do $$ begin
  execute format('revoke all on sequence %s from ytstudio_app', pg_get_serial_sequence('public.approvals', 'seq'));
end $$;

-- Content rows are what approvals bind to: the app role may add versions but never edit or delete one.
revoke update, delete, truncate on video_content from ytstudio_app;
