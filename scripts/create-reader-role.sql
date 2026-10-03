\getenv reader_password BEACON_READER_PASSWORD
\if :{?reader_password}
\else
DO $$ BEGIN RAISE EXCEPTION 'BEACON_READER_PASSWORD must be set and nonempty'; END $$;
\quit
\endif
SELECT length(:'reader_password') > 0 AS password_present \gset
\if :password_present
\else
DO $$ BEGIN RAISE EXCEPTION 'BEACON_READER_PASSWORD must be set and nonempty'; END $$;
\quit
\endif

BEGIN;
DO $$
DECLARE
    table_name text;
    reader_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'beacon_reader');
BEGIN
    FOREACH table_name IN ARRAY ARRAY['beacon_events','beacon_meta','beacon_short_links','beacon_erasures'] LOOP
        IF NOT EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                       WHERE n.nspname='public' AND c.relname=table_name AND c.relkind='r') THEN
            RAISE EXCEPTION 'Required public.% permanent table is missing', table_name;
        END IF;
    END LOOP;
    IF EXISTS (SELECT FROM pg_auth_members WHERE member=reader_oid)
       OR EXISTS (SELECT FROM pg_database WHERE datdba=reader_oid)
       OR EXISTS (SELECT FROM pg_namespace WHERE nspowner=reader_oid)
       OR EXISTS (SELECT FROM pg_class WHERE relowner=reader_oid) THEN
        RAISE EXCEPTION 'Unsafe beacon_reader ownership or membership; operator must remove it before provisioning';
    END IF;
    IF EXISTS (SELECT FROM pg_database d,
               LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
               WHERE datname=current_database() AND grantee=0 AND privilege_type='CREATE')
       OR EXISTS (SELECT FROM pg_namespace n,
               LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
               WHERE nspname='public' AND grantee=0 AND privilege_type='CREATE')
       OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace,
               LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
               WHERE n.nspname='public'
                 AND c.relname IN ('beacon_events','beacon_meta','beacon_short_links','beacon_erasures')
                 AND grantee=0 AND privilege_type <> 'SELECT')
       OR EXISTS (SELECT FROM pg_attribute att JOIN pg_class c ON c.oid=att.attrelid
               JOIN pg_namespace n ON n.oid=c.relnamespace, LATERAL aclexplode(att.attacl) a
               WHERE n.nspname='public'
                 AND c.relname IN ('beacon_events','beacon_meta','beacon_short_links','beacon_erasures')
                 AND grantee=0 AND privilege_type <> 'SELECT') THEN
        RAISE EXCEPTION 'Unsafe beacon_reader PUBLIC privileges; operator must resolve shared CREATE/write grants before provisioning';
    END IF;
END $$;

SELECT 'CREATE ROLE beacon_reader' WHERE NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname='beacon_reader'
) \gexec
-- PostgreSQL requires elevated authority even for no-op privilege resets.
SELECT format('ALTER ROLE beacon_reader LOGIN %s %s %s %s %s PASSWORD %L',
              CASE WHEN rolsuper THEN 'NOSUPERUSER' ELSE '' END,
              CASE WHEN rolcreatedb THEN 'NOCREATEDB' ELSE '' END,
              CASE WHEN rolcreaterole THEN 'NOCREATEROLE' ELSE '' END,
              CASE WHEN rolreplication THEN 'NOREPLICATION' ELSE '' END,
              CASE WHEN rolbypassrls THEN 'NOBYPASSRLS' ELSE '' END, :'reader_password')
FROM pg_roles WHERE rolname='beacon_reader' \gexec

SELECT format('REVOKE CREATE ON DATABASE %I FROM beacon_reader', current_database()) \gexec
SELECT format('GRANT CONNECT, TEMPORARY ON DATABASE %I TO beacon_reader', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM beacon_reader;
GRANT USAGE ON SCHEMA public TO beacon_reader;
REVOKE ALL ON TABLE public.beacon_events, public.beacon_meta, public.beacon_short_links, public.beacon_erasures FROM beacon_reader;
GRANT SELECT ON TABLE public.beacon_events, public.beacon_meta, public.beacon_short_links, public.beacon_erasures TO beacon_reader;
DO $$ BEGIN
    IF EXISTS (SELECT FROM pg_namespace
               WHERE nspname !~ '^pg_(toast_)?temp_'
                 AND has_schema_privilege('beacon_reader', oid, 'CREATE')) THEN
        RAISE EXCEPTION 'Unsafe beacon_reader CREATE access to a permanent schema; operator must resolve its grants';
    END IF;
END $$;
COMMIT;
