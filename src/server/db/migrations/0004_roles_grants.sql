-- Least privilege for the runtime role. Runs as ytstudio_owner (see infra/db-bootstrap.sql); fails if the roles do not exist.
-- Tables and sequences created by LATER migrations get app DML automatically (no TRUNCATE, REFERENCES or TRIGGER).
alter default privileges for role ytstudio_owner in schema public grant select, insert, update, delete on tables to ytstudio_app;
alter default privileges for role ytstudio_owner in schema public grant usage, select on sequences to ytstudio_app;

grant select, insert, update, delete on all tables in schema public to ytstudio_app;
grant usage, select on all sequences in schema public to ytstudio_app;

-- Tighten: audit history is append-only for the app; the migration ledger is read-only.
revoke update, delete, truncate on audit_log from ytstudio_app;
revoke insert, update, delete, truncate on schema_migrations from ytstudio_app;
