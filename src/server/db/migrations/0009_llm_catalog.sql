-- Model catalog and per-stage routing (Doc 08 sections 3-4). Model ids and prices are DATA owned by the owner.
-- Prices are integer micro-USD per million tokens (PriceCard shape in src/server/core/spend.ts).
-- The app role gets DML on the two owner tables through the default privileges of 0004; the suggestions table is read-only for it.

create table if not exists llm_models (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  model_id text not null,
  label text not null,
  base_url text,
  prices jsonb,
  is_free boolean not null default false,
  capabilities jsonb not null,
  -- Derived by the app at write time from base_url and the local-service list; never typed. Re-derived at every use.
  endpoint_kind text not null check (endpoint_kind in ('local', 'hosted')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Defence in depth for "no unpriced paid calls" and "only local can be free" (the app checks both first).
  constraint llm_models_priced_to_enable check (not enabled or is_free or prices is not null),
  constraint llm_models_free_is_local check (not is_free or (endpoint_kind = 'local' and prices is null))
);

create unique index if not exists llm_models_identity on llm_models (provider, model_id, coalesce(base_url, ''));

-- One model per stage. No fallback column on purpose: a failed call is an error the owner sees, never a silent switch.
-- ON DELETE RESTRICT: a routed model cannot be deleted.
create table if not exists llm_routes (
  stage text primary key,
  model_id uuid not null references llm_models (id) on delete restrict,
  updated_at timestamptz not null default now()
);

-- Read-only suggestions the owner copies into llm_models and edits. Prices are left empty on purpose: list prices move,
-- so the owner types the figure from the provider page; price_as_of is set only when a row carries a price.
create table if not exists model_catalog_defaults (
  id text primary key,
  provider text not null,
  model_id text not null,
  label text not null,
  base_url text,
  prices jsonb,
  is_free boolean not null default false,
  capabilities jsonb not null,
  price_as_of date,
  note text not null default 'Suggestion only. Check the provider page for the current price before enabling.'
);

revoke insert, update, delete, truncate on model_catalog_defaults from ytstudio_app;

insert into model_catalog_defaults (id, provider, model_id, label, base_url, is_free, capabilities, note) values
  ('anthropic-sonnet', 'anthropic', 'claude-sonnet-4-5', 'Claude Sonnet', null, false,
   '{"structuredOutput":true,"toolUse":true,"vision":true,"nativeWebSearch":true,"contextWindow":200000}',
   'Suggestion only. Strong all-rounder; check the provider page for the current price and model id.'),
  ('openai-mini', 'openai', 'gpt-4o-mini', 'GPT mini', null, false,
   '{"structuredOutput":true,"toolUse":true,"vision":true,"nativeWebSearch":false,"contextWindow":128000}',
   'Suggestion only. Cheap model for titles and replies; check the provider page for the current price.'),
  ('gemini-flash', 'gemini', 'gemini-2.5-flash', 'Gemini Flash', null, false,
   '{"structuredOutput":true,"toolUse":true,"vision":true,"nativeWebSearch":true,"contextWindow":1000000}',
   'Suggestion only. Economy tier; check the provider page for the current price.'),
  ('deepseek-chat', 'deepseek', 'deepseek-chat', 'DeepSeek chat', null, false,
   '{"structuredOutput":true,"toolUse":true,"vision":false,"nativeWebSearch":false,"contextWindow":64000}',
   'Suggestion only. Economy tier; check the provider page for the current price.'),
  ('ollama-qwen-7b', 'ollama', 'qwen2.5:7b', 'Qwen 2.5 7B (Ollama, this machine)', 'http://localhost:11434/v1', true,
   '{"structuredOutput":true,"toolUse":false,"vision":false,"nativeWebSearch":false,"contextWindow":32000}',
   'Free on this machine. Weak at tool calling (Spike A): use for outline, titles and scene JSON, and search-then-write drafting.'),
  ('lmstudio-local', 'lmstudio', 'local-model', 'LM Studio model (this machine)', 'http://localhost:1234/v1', true,
   '{"structuredOutput":true,"toolUse":false,"vision":false,"nativeWebSearch":false,"contextWindow":32000}',
   'Free on this machine. Set the model id to the one loaded in LM Studio and the capabilities to match it.')
on conflict (id) do nothing;
