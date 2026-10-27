-- Phase 2 Task 16: agent checkpoints. The tool outputs of an agent step whose model call already settled, so a resumed
-- run replays them instead of running the tools again. Keyed by the POSITION of the call inside its step (provider ids
-- can repeat, be empty or be huge, so tool_call_id is metadata only). A row is used only when tool_name and args_hash
-- match what is being asked. First write wins (a replay can never change what the model saw); the app role cannot update,
-- delete or truncate. Writes are fence-gated in agent-steps.ts. No foreign key, like events.
-- Growth is bounded: at most 256 positions per step, 16 KB per output, and prune_agent_steps() removes rows older than 7 days.
create table if not exists agent_steps (
  stage_run_id uuid not null,
  step_index integer not null check (step_index >= 0),
  call_index integer not null check (call_index between 0 and 255),
  tool_call_id text not null check (octet_length(tool_call_id) <= 800),
  tool_name text not null check (octet_length(tool_name) <= 800),
  args_hash text not null check (length(args_hash) = 64),
  output text not null check (octet_length(output) <= 16384),
  fence bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (stage_run_id, step_index, call_index)
);
create index if not exists agent_steps_created on agent_steps (created_at);
revoke update, delete, truncate on agent_steps from ytstudio_app;

create or replace function prune_agent_steps() returns bigint
language plpgsql security definer set search_path = pg_catalog, public as $$
declare n bigint;
begin
  delete from agent_steps where created_at < clock_timestamp() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function prune_agent_steps() from public;
grant execute on function prune_agent_steps() to ytstudio_app;
