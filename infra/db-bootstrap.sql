-- Run ONCE as a Postgres superuser against the target database (npm run db:bootstrap). Idempotent.
-- Passwords arrive as transaction settings (bootstrap.owner_pw / bootstrap.app_pw / bootstrap.backup_pw) so they are never written into this file.
-- ytstudio_backup is optional (compose): created only when bootstrap.backup_pw is non-empty.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ytstudio_owner') then
    execute format('create role ytstudio_owner login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', current_setting('bootstrap.owner_pw'));
  else
    execute format('alter role ytstudio_owner login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', current_setting('bootstrap.owner_pw'));
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ytstudio_app') then
    execute format('create role ytstudio_app login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', current_setting('bootstrap.app_pw'));
  else
    execute format('alter role ytstudio_app login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', current_setting('bootstrap.app_pw'));
  end if;
  -- Read-only role for the backup job: pg_read_all_data = SELECT on every table, view and sequence (including ones created later)
  -- and USAGE on every schema, and nothing else. It lets backups run without the owner URL. It does not touch the app role's rights.
  if coalesce(current_setting('bootstrap.backup_pw', true), '') <> '' then
    if not exists (select 1 from pg_roles where rolname = 'ytstudio_backup') then
      execute format('create role ytstudio_backup login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', current_setting('bootstrap.backup_pw'));
    else
      execute format('alter role ytstudio_backup login nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L', current_setting('bootstrap.backup_pw'));
    end if;
    grant pg_read_all_data to ytstudio_backup;
  end if;
  -- Pre-flight: migration 0004's default privileges only cover objects the owner role creates. Objects owned by anyone else
  -- would silently stay ungranted, so refuse and say which ones.
  perform 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
     and c.relowner <> (select oid from pg_roles where rolname = 'ytstudio_owner')
     and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')); -- skip owned sequences
  if found then
    raise exception 'bootstrap aborted: schema public holds objects not owned by ytstudio_owner (%). Re-own them or recreate the database.',
      (select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
          and c.relowner <> (select oid from pg_roles where rolname = 'ytstudio_owner')
          and not exists (select 1 from pg_depend d where d.objid = c.oid and d.deptype in ('a', 'i')));
  end if;
  execute format('alter database %I owner to ytstudio_owner', current_database());
  execute format('revoke all on database %I from public', current_database());
  execute format('grant connect on database %I to ytstudio_owner, ytstudio_app', current_database());
  if exists (select 1 from pg_roles where rolname = 'ytstudio_backup') then
    execute format('grant connect on database %I to ytstudio_backup', current_database());
  end if;
end
$$;

-- Nobody but the owner creates objects; the app may only look up names in the schema.
alter schema public owner to ytstudio_owner;
revoke all on schema public from public;
grant usage on schema public to ytstudio_app;
