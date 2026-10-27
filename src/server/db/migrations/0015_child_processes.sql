-- Live host-tool children (ffprobe/ffmpeg/...) started by a worker. A worker that is SIGKILLed leaves these behind;
-- the next boot's sweepOrphans finds each row's process (pid + start time + command must all match, so a reused pid is
-- never killed) and removes the row. Numbered 0015 as the Phase 2 plan reserves; the migrator applies by name.
create table if not exists child_processes (
  pid integer not null check (pid > 1),
  started_at_epoch bigint not null,
  command_label text not null check (length(command_label) between 1 and 200),
  worker_id text not null,
  stage_run_id uuid not null,
  registered_at timestamptz not null default clock_timestamp(),
  primary key (pid, started_at_epoch)
);
