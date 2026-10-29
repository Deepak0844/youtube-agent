-- Phase 3 Task 12: ElevenLabs sound-effect and music prices. Source: https://elevenlabs.io/pricing/api, read 2026-10-29:
-- "Sound Effects $0.12 Price per minute", "Music $0.15 Price per minute" (USD, not credits). The page also says both are
-- "billed per generation", so a very short clip may bill more than its seconds; the quote is the per-minute rate pro rata.
-- 0.12/60 = 2000 and 0.15/60 = 2500 micro-USD per second. Only fills the unpriced seed: a price the owner already set is kept.
update media_providers set price = '{"unit":"per_second","microUsd":2000}', updated_at = now()
where id = 'elevenlabs_sfx' and price = '{}'::jsonb;
update media_providers set price = '{"unit":"per_second","microUsd":2500}', updated_at = now()
where id = 'elevenlabs_music' and price = '{}'::jsonb;
