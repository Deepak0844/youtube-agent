-- Owner "run again" nonces for finished free steps (render, voice, sfx, qa), per video. Mixed into a step's input hash
-- only when set, so every existing hash is unchanged.
alter table videos add column if not exists stage_nonces jsonb not null default '{}'::jsonb;
