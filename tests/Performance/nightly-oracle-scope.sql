\set ON_ERROR_STOP on
\set QUIET 1
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog, pg_temp;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout TO '120s';

SELECT current_database() = :'database_name' AND current_database() ~ '^fsusv2_nightly_[0-9a-f]{32}$'
    AND current_setting('data_directory') = :'data_directory'
    AND current_user = 'fsusv2_nightly_qa'
    AND inet_server_addr() IS NULL AND current_setting('listen_addresses') = ''
    AND current_setting('server_encoding') = 'UTF8' AND current_setting('session_replication_role') = 'origin'
    AND :'profile' = 'nightly'
    AND :'fixture_sha256' ~ '^[0-9a-f]{64}$' AND :'readback_sha256' ~ '^[0-9a-f]{64}$'
    AND (SELECT count(*) = 1 AND bool_and(singleton AND version = 1) FROM public.v2_schema)
    AND (SELECT count(*) = 1 AND bool_and(singleton AND site_id = :'site_id'::uuid)
         FROM public.authoring_recovery_site) AS owned \gset
