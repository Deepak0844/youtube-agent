-- Price integrity for llm_models. The price block is jsonb, so without this the app role could UPDATE it to zeros, strings
-- or junk and a paid model would be reserved at $0. The app validates on write AND read; this is the database's own guard.
-- (0009 is already applied elsewhere and is not edited. Idempotent: safe to re-run.)
alter table llm_models drop constraint if exists llm_models_price_shape;
alter table llm_models add constraint llm_models_price_shape check (
  is_free or prices is null or coalesce(
    jsonb_typeof(prices) = 'object'
    and jsonb_typeof(prices -> 'inputPerMTokMicro') = 'number'
    and jsonb_typeof(prices -> 'outputPerMTokMicro') = 'number'
    and (prices ->> 'inputPerMTokMicro') ~ '^[1-9][0-9]{0,11}$'
    and (prices ->> 'outputPerMTokMicro') ~ '^[1-9][0-9]{0,11}$'
    and (prices - array['inputPerMTokMicro', 'outputPerMTokMicro', 'cacheWritePerMTokMicro', 'cacheReadPerMTokMicro',
                        'reasoningPerMTokMicro', 'perCallMicro', 'perImageMicro']) = '{}'::jsonb
    and not jsonb_path_exists(prices, '$.* ? (@.type() != "number" || @ < 0 || @ > 1000000000000 || @.floor() != @)')
  , false)
);

-- Suggestions are read-only for the app role: no triggers or foreign keys onto them either.
revoke trigger, references on model_catalog_defaults from ytstudio_app;
