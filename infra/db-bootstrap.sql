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
  execute format('alter database %I owner to ytstudio_owner', current_database());
  execute format('revoke all on database %I from public', current_database());
  execute format('grant connect on database %I to ytstudio_owner, ytstudio_app', current_database());
end
$$;

-- Nobody but the owner creates objects; the app may only look up names in the schema.
alter schema public owner to ytstudio_owner;
revoke all on schema public from public;
grant usage on schema public to ytstudio_app;
