-- Phase 3 Task 02: media provider registry, stored provider job ids, media routes.
-- Seed rows are all disabled. `price` is {} (unpriced, refused) wherever the figure is `unrecorded`: no number is typed
-- here until the owner copies it from the provider's public pricing page. Only providers that cost nothing carry a free rule.
create table if not exists media_providers (
  id text primary key,
  kind text not null check (kind in ('voice', 'music', 'sfx', 'image', 'stock')),
  label text not null,
  enabled boolean not null default false,
  base_url text,
  commercial_use text not null default 'unknown' check (commercial_use in ('yes', 'no', 'unknown')),
  word_timings text check (word_timings in ('native', 'aligned', 'estimated', 'none')),
  local boolean not null default false,
  languages text[] not null default '{}',
  price jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- One row per (stage run, step): the unique key is what makes a restart find the job it already submitted.
-- No foreign key and no delete for the app: a paid job record outlives the stage that made it.
create table if not exists media_jobs (
  id uuid primary key,
  stage_run_id uuid not null,
  step integer not null,
  provider text not null,
  kind text not null,
  provider_job_id text,
  state text not null default 'submitting' check (state in ('submitting', 'submitted', 'done', 'failed_known', 'unknown')),
  quote_micro_usd bigint not null check (quote_micro_usd >= 0),
  actual_micro_usd bigint check (actual_micro_usd >= 0),
  artifact jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (stage_run_id, step)
);
revoke delete, truncate on media_jobs from ytstudio_app;

-- scope: 'default', 'format:<short|long>' or 'kind:<video kind>'. No fallback column: a missing route is an error, never a switch.
create table if not exists media_routes (
  kind text not null,
  scope text not null,
  provider text not null,
  voice text,
  model text,
  primary key (kind, scope)
);

-- price '{}' = unrecorded. Free rules: edge, voicestudio, and the stock libraries (no per-call charge).
insert into media_providers (id, kind, label, word_timings, local, price) values
  ('elevenlabs', 'voice', 'ElevenLabs voice', null, false, '{}'),
  ('elevenlabs_music', 'music', 'ElevenLabs music', null, false, '{}'),
  ('elevenlabs_sfx', 'sfx', 'ElevenLabs sound effects', null, false, '{}'),
  ('edge', 'voice', 'Edge voices', 'native', false, '{"unit":"free","microUsd":0}'),
  ('voicestudio', 'voice', 'VoiceStudio', 'aligned', true, '{"unit":"free","microUsd":0}'),
  ('local_openai', 'voice', 'Local OpenAI-compatible voice', null, true, '{}'),
  ('custom_http', 'voice', 'Custom HTTP voice', null, false, '{}'),
  ('google_tts', 'voice', 'Google text to speech', null, false, '{}'),
  ('azure_tts', 'voice', 'Azure text to speech', null, false, '{}'),
  ('gemini_image', 'image', 'Gemini images', null, false, '{}'),
  ('openai_image', 'image', 'OpenAI images', null, false, '{}'),
  ('fal_image', 'image', 'fal images', null, false, '{}'),
  ('pexels', 'stock', 'Pexels', null, false, '{"unit":"free","microUsd":0}'),
  ('pixabay', 'stock', 'Pixabay', null, false, '{"unit":"free","microUsd":0}'),
  ('coverr', 'stock', 'Coverr', null, false, '{"unit":"free","microUsd":0}'),
  ('own_stock', 'stock', 'Your own stock', null, true, '{"unit":"free","microUsd":0}')
on conflict (id) do nothing;
