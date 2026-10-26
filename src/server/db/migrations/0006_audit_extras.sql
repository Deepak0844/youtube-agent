-- Audit list screens page by id and filter by event prefix; these keep both cheap as the log grows.
-- Plain indexes only: audit_log stays insert+select for the app role (see 0004), nothing here changes grants.
create index audit_log_at_idx on audit_log (at desc);
create index audit_log_event_idx on audit_log (event text_pattern_ops, id desc);
