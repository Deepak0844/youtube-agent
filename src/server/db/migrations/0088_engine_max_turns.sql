-- OpenMontage parity, Phase D1 (owner 2026-11-14): drawing objects needs more engine turns than the first default of 80.
-- Raises the seeded value to 150 only when nobody has edited it (still the system's seed of 80).
update settings set value = '150', updated_at = now()
 where key = 'engine.max_turns' and value = '80' and updated_by = 'system';
