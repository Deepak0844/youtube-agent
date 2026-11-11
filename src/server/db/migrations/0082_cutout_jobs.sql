-- Phase 8: cut-outs of library pictures are made by the worker (the web process never decodes pictures or runs the model). The page adds a row; the
-- worker takes the oldest queued row, one at a time, and writes the result or a plain sentence saying why not. The app role gets the default grants.
create table if not exists cutout_jobs (
  id uuid primary key default gen_random_uuid(),
  asset_id uuid not null references assets (id) on delete cascade,
  options jsonb not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  result_asset_id uuid references assets (id) on delete set null,
  error text check (error is null or length(error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists cutout_jobs_status_idx on cutout_jobs (status, created_at);
create index if not exists cutout_jobs_asset_idx on cutout_jobs (asset_id, created_at desc);
