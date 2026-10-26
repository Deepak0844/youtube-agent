-- TOTP enrollment in progress: the secret is held here until the owner proves a code; only then it moves to totp_secret.
-- Raw secret for now (Phase 1 vault encrypts it). Never log it.
alter table owner add column totp_pending_secret text;
