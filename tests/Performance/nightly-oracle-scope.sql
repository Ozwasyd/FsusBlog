\ir nightly-oracle-session.sql

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
