-- TOTP secrets move into the vault (secrets rows 'totp.secret' / 'totp.pending'). The owner columns then hold only a marker.
-- This migration cannot encrypt (it has no master key): rows written before it stay plaintext with totp_encrypted = false until
-- scripts/totp-backfill.ts runs (db:migrate does it). Until then TOTP login fails closed; there is no plaintext fallback.
alter table owner add column totp_encrypted boolean not null default false;
