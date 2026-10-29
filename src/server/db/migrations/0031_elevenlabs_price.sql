-- Phase 3 Task 05: ElevenLabs voice price. Source: https://elevenlabs.io/pricing/api, read 2026-10-29:
-- "v3 $0.08 / v2 Multilingual $0.08, Price per 1K characters" (Flash/Turbo $0.04 are not supported by the adapter).
-- 80000 micro-USD per 1,000 characters. API usage is billed in USD; the free allowance does not change the quote.
-- Only fills the unpriced seed: a price the owner already set is kept.
update media_providers set price = '{"unit":"per_1k_chars","microUsd":80000}', updated_at = now()
where id = 'elevenlabs' and price = '{}'::jsonb;
