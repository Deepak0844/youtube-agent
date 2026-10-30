-- Phase 3 Task 14: image prices, read from the providers' public pages on 2026-10-30. Only fills the unpriced seed: a price the owner already set is kept.
-- gemini_image: https://ai.google.dev/gemini-api/docs/pricing , Gemini 3.1 Flash Lite Image (gemini-3.1-flash-lite-image), Standard tier,
--   1K image: $0.0336 = 33600 micro-USD (image output only). The adapter only asks for 1K (the model's only size) and DELIBERATELY
--   over-quotes this rule by +10% plus +5% per reference image for input tokens and returned text, whose rates were not read from the page. The older gemini-2.5-flash-image is deprecated and not offered.
-- fal_image: https://fal.ai/models/fal-ai/flux/schnell , "$0.003 per megapixel", "billed by rounding up to the nearest megapixel".
--   Every size the adapter asks for is under 1 MP, so one image = 3000 micro-USD.
-- openai_image: NOT priced. OpenAI's pricing page lists only per-token image prices (gpt-image-2, gpt-image-1-mini) and points to a calculator;
--   no per-image figure could be read from the live page, so it stays unpriced (refused) until the owner records one. The adapter is pinned to
--   model gpt-image-1-mini, quality low, PNG; a future rule must be the per-image price of exactly that tier at the LARGEST size (1024x1536 / 1536x1024).
update media_providers set price = '{"unit":"per_image","microUsd":33600}', updated_at = now()
where id = 'gemini_image' and price = '{}'::jsonb;
update media_providers set price = '{"unit":"per_image","microUsd":3000}', updated_at = now()
where id = 'fal_image' and price = '{}'::jsonb;
