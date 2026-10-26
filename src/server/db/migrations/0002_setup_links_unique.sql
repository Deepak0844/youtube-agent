-- At most one live (unused) setup link per purpose. Superseded and expired links are marked used before a new one is inserted.
create unique index setup_links_one_live_per_purpose on setup_links (purpose) where used_at is null;
