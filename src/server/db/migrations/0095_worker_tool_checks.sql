-- One row: what the worker last saw when it checked Docker and the render image. In compose the web app has no Docker access, so
-- System status shows this instead of a false "not running". The worker reports at boot and every 10 minutes (upsert).
create table if not exists worker_tool_checks (
  id boolean primary key default true check (id),
  checks jsonb not null,
  at timestamptz not null
);
revoke delete, truncate on worker_tool_checks from ytstudio_app;
