-- Encrypted secrets (provider API keys, later TOTP secrets). Plaintext never lands here: see src/server/core/vault-crypto.ts.
-- ciphertext = AES-256-GCM data || 16-byte tag; nonce is fresh per write; key_id labels which master key sealed the row.
-- `hint` is the non-secret masked tail (last 4 chars, empty for short values) so listings never need to decrypt.
-- The app role gets the default select/insert/update/delete from 0004 (it must write and replace keys); no TRUNCATE.
create table secrets (
  name       text primary key check (name ~ '^[a-z0-9][a-z0-9._-]{0,127}$'),
  ciphertext bytea not null check (octet_length(ciphertext) between 16 and 65600),
  nonce      bytea not null check (octet_length(nonce) = 12),
  key_id     text not null check (key_id ~ '^[0-9a-f]{8}$'),
  hint       text not null default '' check (char_length(hint) <= 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
