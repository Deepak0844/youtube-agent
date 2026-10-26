-- Run ONCE as a Postgres superuser against the target database (npm run db:bootstrap). Idempotent.
-- Passwords arrive as transaction settings (bootstrap.owner_pw / bootstrap.app_pw) so they are never written into this file.
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
end
$$;

-- Nobody but the owner creates objects; the app may only look up names in the schema.
alter schema public owner to ytstudio_owner;
revoke all on schema public from public;
grant usage on schema public to ytstudio_app;
