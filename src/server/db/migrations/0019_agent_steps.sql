-- Phase 2 Task 16: agent checkpoints. The tool outputs of an agent step whose model call already settled, so a resumed
-- run replays them instead of running the tools again. First write wins (a replay can never change what the model saw);
-- the app role cannot update or delete. Writes are fence-gated in agent-steps.ts. No foreign key, like events: stage_runs
-- rows are never deleted by the app, and a checkpoint row is meaningless without its stage anyway.
create table if not exists agent_steps (
  stage_run_id uuid not null,
  step_index integer not null check (step_index >= 0),
  tool_call_id text not null check (length(tool_call_id) between 1 and 200),
  output text not null check (octet_length(output) <= 16384),
  fence bigint not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (stage_run_id, step_index, tool_call_id)
);
revoke update, delete, truncate on agent_steps from ytstudio_app;
