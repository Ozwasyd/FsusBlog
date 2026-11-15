\set ON_ERROR_STOP on
\if :{?expected_history}
\else
\set expected_history 0
\endif
\if :{?expected_rights_projection}
\else
\set expected_rights_projection 0
\endif
\if :{?media_profile}
\else
\set media_profile false
\endif
\if :{?republish_profile}
\else
\set republish_profile false
\endif
\if :media_profile
\set revision_count 3
\set public_revision 2
\set publication_count 2
\set responsibility_count 3
\set proof_binding true
\set publication_id 900000002
\set rights_id 701
\set category_next 13
\set tag_next 24
\set publication_next 900000003
\set rights_next 702
\set owner_enabled true
\elif :republish_profile
\set revision_count 2
\set public_revision 2
\set publication_count 2
\set responsibility_count 0
\set proof_binding false
\set publication_id 900000002
\set rights_id 701
\set category_next 13
\set tag_next 24
\set publication_next 900000003
\set rights_next 702
\set owner_enabled false
\elif :rollback_profile
\set revision_count 3
\set public_revision 3
\set publication_count 3
\set responsibility_count 2
\set proof_binding true
\set publication_id 900000003
\set rights_id 702
\set category_next 13
\set tag_next 24
\set publication_next 900000004
\set rights_next 703
\set owner_enabled false
\else
\set revision_count 1
\set public_revision 1
\set publication_count 1
\set responsibility_count 0
\set proof_binding false
\set publication_id 900000001
\set rights_id 700
\set category_next 12
\set tag_next 22
\set publication_next 900000002
\set rights_next 701
\set owner_enabled false
\endif

\if :{?mixed_profile}
\else
\set mixed_profile false
\endif
\if :{?media_batch}
\else
\set media_batch false
\endif
\if :media_batch
\set article_count 2
\set media_count 3
\set media_references 4
\set article_next 44
\else
\set article_count 1
\set media_count 1
\set media_references 1
\set article_next 43
\endif
\if :mixed_profile
\set article_count 2
\set article_next 44
\set publication_next 900000004
\set rights_next 703
\endif

\if :copy_out
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
\else
BEGIN ISOLATION LEVEL REPEATABLE READ;
\endif
SET LOCAL search_path TO pg_catalog;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL statement_timeout TO '15s';

SELECT current_database()=:'database_name'
    AND (SELECT oid FROM pg_database WHERE datname=current_database())=:'database_oid'::oid
    AND (SELECT site_id FROM public.authoring_recovery_site WHERE singleton)=:'site_id'::uuid
    AND inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
    AND current_setting('session_replication_role')='origin'
    AND pg_try_advisory_xact_lock(716729109726707501::bigint)
    AND pg_try_advisory_xact_lock(1179866434,1) AS expected_database \gset
\if :expected_database
\else
DO $$ BEGIN RAISE EXCEPTION 'Rehearsal transfer database identity or ownership lock differs'; END $$;
\endif

\if :copy_out
\if :source_seal
SELECT (SELECT version=-1 FROM public.v2_schema WHERE singleton)
    AND (SELECT NOT serving AND site_id=:'site_id'::uuid AND plan_sha256=:'plan_sha'
         FROM fsus_legacy_candidate.candidate WHERE singleton)
    AND (SELECT plan_sha256=:'plan_sha' AND projection_sha256=:'projection_sha'
         FROM fsus_legacy_candidate.current_projection WHERE singleton)
    AND (SELECT count(*) FROM fsus_legacy_candidate.shadow_publication)=:publication_count+(:mixed_profile)::int
    AND (SELECT count(*) FROM fsus_legacy_candidate.shadow_article_responsibility_snapshot)=:responsibility_count+:expected_history AS expected_seal \gset
\if :media_profile
SELECT :'expected_seal'::boolean AND (SELECT count(*) FROM fsus_legacy_candidate.shadow_content_asset)=:media_count
    AND (SELECT count(*) FROM fsus_legacy_candidate.shadow_content_asset_reference)=:media_references AS expected_seal \gset
\else
SELECT :'expected_seal'::boolean AND (SELECT count(*) FROM fsus_legacy_candidate.shadow_article_mutation_outbox)=:publication_count+(:mixed_profile)::int+:expected_history+:expected_rights_projection
    AND (SELECT count(*) FROM fsus_legacy_candidate.shadow_article_mutation_outbox_edge)=7*(:publication_count+(:mixed_profile)::int)+9*:expected_history+10*:expected_rights_projection AS expected_seal \gset
\endif
\else
SELECT (SELECT version=1 FROM public.v2_schema WHERE singleton)
    AND to_regnamespace('fsus_legacy_candidate') IS NULL
    AND (SELECT count(*) FROM public.blog_user)=:article_count-(:mixed_profile)::int
    AND (SELECT enabled=:owner_enabled AND can_author=:owner_enabled FROM public.blog_user WHERE id=:'owner_id'::uuid) AS expected_seal \gset
\endif
\if :expected_seal
\else
DO $$ BEGIN RAISE EXCEPTION 'Rehearsal source seal or runtime readback identity differs'; END $$;
\endif

SELECT (SELECT count(*) FROM public.article)=:article_count
    AND (SELECT count(*) FROM public.article_publication)=1+(:mixed_profile)::int
    AND (SELECT NOT deleted AND revision=:revision_count AND published_revision=:public_revision
             AND publication_count=:publication_count AND owner_id=:'owner_id'::uuid
         FROM public.article WHERE id=42)
    AND (SELECT array_agg(revision ORDER BY revision) FROM public.article_revision WHERE article_id=42)
        = ARRAY(SELECT n::bigint FROM generate_series(1,:revision_count) n)
    AND (SELECT count(*)=:publication_count AND bool_and(enabled AND proof_binding_enabled=:'proof_binding'::boolean)
         FROM public.article_revision_rights WHERE article_id=42)
    AND (SELECT publication_id=:publication_id AND publication_no=:publication_count AND revision=:public_revision
         FROM public.article_publication WHERE article_id=42)
    AND (SELECT count(*)=1 AND bool_and(event_no=1 AND revision=:public_revision
             AND publication_id=:publication_id AND publication_no=:publication_count AND kind='retained-active'
             AND reason='pre-history' AND supersedes_id IS NULL AND actor_id IS NULL AND command_id IS NULL
             AND admin_actor_id IS NULL AND admin_command_id IS NULL)
         FROM public.article_publication_history WHERE article_id=42)
    AND (SELECT count(*)=:publication_count AND bool_and(id=699+revision AND publication_id=900000000+revision)
             AND max(id)=:rights_id FROM public.article_publication_rights WHERE article_id=42)
    AND NOT EXISTS (SELECT FROM public.article_rollback)
    AND NOT EXISTS (SELECT FROM public.admin_article_rollback)
    AND NOT EXISTS (SELECT FROM public.article_command)
    AND NOT EXISTS (SELECT FROM public.blog_outbox)
    AND NOT EXISTS (SELECT FROM public.article_publication_canonical)
    AND NOT EXISTS (SELECT FROM public.article_publication_proof)
    AND (SELECT last_value=:article_next AND NOT is_called FROM public.article_id_seq)
    AND (SELECT last_value=:category_next AND NOT is_called FROM public.category_id_seq)
    AND (SELECT last_value=:tag_next AND NOT is_called FROM public.tag_id_seq)
    AND (SELECT last_value=:publication_next AND NOT is_called FROM public.article_publication_publication_id_seq)
    AND (SELECT last_value=:rights_next AND NOT is_called FROM public.article_publication_rights_id_seq) AS eligible \gset
\if :eligible
\else
DO $$ BEGIN RAISE EXCEPTION 'Sealed source differs from the supported publication rehearsal'; END $$;
\endif

\if :media_batch
SELECT (SELECT NOT deleted AND revision=2 AND published_revision IS NULL AND publication_count=0
        AND owner_id=:'owner2'::uuid FROM public.article WHERE id=43)
    AND (SELECT array_agg(revision ORDER BY revision)=ARRAY[1::bigint,2::bigint] FROM public.article_revision WHERE article_id=43)
    AND (SELECT enabled AND can_author FROM public.blog_user WHERE id=:'owner2'::uuid) AS verified_second_article \gset
\if :verified_second_article
\else
DO $$ BEGIN RAISE EXCEPTION 'Second private article or its reviewed owner differs'; END $$;
\endif
\endif

\if :mixed_profile
SELECT (SELECT NOT deleted AND revision=1 AND published_revision=1 AND publication_count=1
        AND owner_id=:'owner_id'::uuid FROM public.article WHERE id=43)
    AND (SELECT publication_id=900000003 AND revision=1 FROM public.article_publication WHERE article_id=43)
    AND (SELECT array_agg(id)=ARRAY[702::bigint] FROM public.article_publication_rights WHERE article_id=43)
    AS verified_first_article \gset
\if :verified_first_article
\else
DO $$ BEGIN RAISE EXCEPTION 'The independent immediate first publication differs'; END $$;
\endif
\endif

\copy (SELECT id,name,description FROM public.category ORDER BY id) TO 'category.csv' CSV
\copy (SELECT id,name,description FROM public.tag ORDER BY id) TO 'tag.csv' CSV
\copy (SELECT name_key,tag_id FROM public.tag_url_name ORDER BY name_key) TO 'tag_url_name.csv' CSV
\copy (SELECT id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at FROM public.article ORDER BY id) TO 'article.csv' CSV
\copy (SELECT article_id,revision,title,body,happened_at,author_summary FROM public.article_revision ORDER BY article_id,revision) TO 'article_revision.csv' CSV
\copy (SELECT article_id,revision,category_id FROM public.article_revision_category ORDER BY article_id,revision) TO 'article_revision_category.csv' CSV
\copy (SELECT article_id,revision,tag_id FROM public.article_revision_tag ORDER BY article_id,revision,tag_id) TO 'article_revision_tag.csv' CSV
\copy (SELECT article_id,publication_id,revision,publication_no,published_at FROM public.article_publication ORDER BY article_id) TO 'article_publication.csv' CSV
\copy (SELECT article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,recorded_at,actor_id,command_id FROM public.article_publication_history ORDER BY article_id,event_no) TO 'article_publication_history.csv' CSV
\copy (SELECT article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled FROM public.article_revision_rights ORDER BY article_id,revision) TO 'article_revision_rights.csv' CSV
\copy (SELECT id,article_id,publication_id,revision FROM public.article_publication_rights ORDER BY id) TO 'article_publication_rights.csv' CSV
\else
SELECT (SELECT version=1 FROM public.v2_schema WHERE singleton)
    AND to_regnamespace('fsus_legacy_candidate') IS NULL
    AND NOT EXISTS (SELECT FROM public.blog_user)
    AND NOT EXISTS (SELECT FROM public.article)
    AND NOT EXISTS (SELECT FROM public.category)
    AND NOT EXISTS (SELECT FROM public.tag) AS pristine \gset
\if :pristine
\else
DO $$ BEGIN RAISE EXCEPTION 'Rehearsal runtime target is not pristine'; END $$;
\endif

INSERT INTO public.blog_user (id,name,can_author,enabled,generation)
    VALUES (:'owner_id'::uuid,'Legacy rehearsal custodian',:owner_enabled,:owner_enabled,1);
\if :media_batch
INSERT INTO public.blog_user (id,name,can_author,enabled,generation)
    VALUES (:'owner2'::uuid,'Legacy rehearsal second custodian',true,true,1);
\endif
\copy public.category (id,name,description) FROM 'category.csv' CSV
\copy public.tag (id,name,description) FROM 'tag.csv' CSV
\copy public.tag_url_name (name_key,tag_id) FROM 'tag_url_name.csv' CSV
\copy public.article (id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at) FROM 'article.csv' CSV
\copy public.article_revision (article_id,revision,title,body,happened_at,author_summary) FROM 'article_revision.csv' CSV
\copy public.article_revision_category (article_id,revision,category_id) FROM 'article_revision_category.csv' CSV
\copy public.article_revision_tag (article_id,revision,tag_id) FROM 'article_revision_tag.csv' CSV
\copy public.article_publication (article_id,publication_id,revision,publication_no,published_at) FROM 'article_publication.csv' CSV
\copy public.article_publication_history (article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,recorded_at,actor_id,command_id) FROM 'article_publication_history.csv' CSV
\copy public.article_revision_rights (article_id,revision,enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled) FROM 'article_revision_rights.csv' CSV
\copy public.article_publication_rights (id,article_id,publication_id,revision) FROM 'article_publication_rights.csv' CSV
ALTER SEQUENCE public.article_id_seq RESTART WITH :article_next;
ALTER SEQUENCE public.category_id_seq RESTART WITH :category_next;
ALTER SEQUENCE public.tag_id_seq RESTART WITH :tag_next;
ALTER SEQUENCE public.article_publication_publication_id_seq RESTART WITH :publication_next;
ALTER SEQUENCE public.article_publication_rights_id_seq RESTART WITH :rights_next;
SET CONSTRAINTS ALL IMMEDIATE;
\if :interrupt_transfer
DO $$ BEGIN RAISE EXCEPTION 'Injected failure after rehearsal transfer'; END $$;
\endif
\endif
COMMIT;
