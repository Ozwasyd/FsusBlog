\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL client_encoding TO 'UTF8';
SET LOCAL statement_timeout TO '15s';

-- Render the same ordered JSON lines from the fixed v1 fixture and the quarantined v2 shadow.
\if :quarantined
\set custody_schema fsus_legacy_candidate
\set category_table shadow_category
\set tag_table shadow_tag
\set alias_table shadow_tag_url_alias
\set article_tag_table shadow_article_tag
\set rights_table shadow_article_rights_snapshot
\set responsibility_table shadow_article_responsibility_snapshot
\set event_table shadow_article_mutation_outbox
\set edge_table shadow_article_mutation_outbox_edge
\set flag_value 1

SELECT json_build_array('article',id,title,summary,cover_image_url,body,source_category_id,source_status,deleted=1,
    current_source_revision_id,current_publication_id,created_at::timestamp,source_metadata_updated_at::timestamp,
    source_body_updated_at::timestamp,published_at::timestamp,last_published_at::timestamp,public_updated_at::timestamp)
FROM fsus_legacy_candidate.shadow_article ORDER BY id;

SELECT json_build_array('revision',source_revision_id,article_id,revision,title,summary,cover_image_url,body,source_category_id,
    source_tag_ids,source_content_block_id,source_content_sha256,source_inline_markdown,source_diff_summary,
    source_admin_id,source_rollback_revision_id,source_rollback_reason,happened_at::timestamp)
FROM fsus_legacy_candidate.shadow_revision ORDER BY article_id,revision;

SELECT json_build_array('publication',source_publication_id,article_id,publication_number,source_revision_id,revision,
    source_rights_snapshot_id,source_responsibility_snapshot_id,source_transition,published_at::timestamp,source_created_at::timestamp)
FROM fsus_legacy_candidate.shadow_publication ORDER BY article_id,publication_number;
\else
\set custody_schema public
\set category_table category
\set tag_table tag
\set alias_table tag_url_alias
\set article_tag_table article_tag
\set rights_table article_rights_snapshot
\set responsibility_table article_responsibility_snapshot
\set event_table article_mutation_outbox
\set edge_table article_mutation_outbox_edge
\set flag_value true

SELECT json_build_array('article',a.id,a.title,a.summary,a.coverimageurl,b.markdown_content,a.categoryid,a.status,a.isdeleted,
    a.current_revision_id,a.current_publication_id,a.createtime::timestamp,a.metadata_updated_at::timestamp,
    b.updated_at::timestamp,a.published_at::timestamp,a.last_published_at::timestamp,a.public_updated_at::timestamp)
FROM public.article a JOIN public.article_body b ON b.article_id=a.id ORDER BY a.id;

SELECT json_build_array('revision',r.id,r.article_id,r.revision_no,r.title,r.summary,r.cover_image_url,b.markdown_content,r.categoryid,
    r.tag_ids,b.id,lower(b.content_hash),r.markdown_content,r.diff_summary,
    r.created_by_admin_principal_id,r.rollback_source_revision_id,r.rollback_reason,r.created_at::timestamp)
FROM public.article_revision r JOIN public.article_revision_content_block b ON b.id=r.content_block_id
ORDER BY r.article_id,r.revision_no;

SELECT json_build_array('publication',id,article_id,publication_no,article_revision_id,revision_no,
    rights_snapshot_id,responsibility_snapshot_id,transition_kind,published_at::timestamp,created_at::timestamp)
FROM public.article_publication ORDER BY article_id,publication_no;
\endif

SELECT json_build_array('category',id,name,description) FROM :"custody_schema".:"category_table" ORDER BY id;
SELECT json_build_array('tag',id,name,description) FROM :"custody_schema".:"tag_table" ORDER BY id;
SELECT json_build_array('tag-alias',normalized_name,tag_id,original_name,created_at_utc::timestamp)
FROM :"custody_schema".:"alias_table" ORDER BY normalized_name COLLATE "C";
SELECT json_build_array('article-tag',articleid,tagid) FROM :"custody_schema".:"article_tag_table" ORDER BY articleid,tagid;

SELECT json_build_array('rights',id,article_id,article_revision_id,revision_no,article_rights_policy_id,enabled=:flag_value,
    license_type,copyright_holder,copyright_year,rights_statement,attribution_template,copy_policy,max_excerpt_chars,
    allow_code_copy=:flag_value,show_public_badge=:flag_value,proof_binding_enabled=:flag_value,canonical_url,
    policy_hash,content_canonical_hash,created_at::timestamp)
FROM :"custody_schema".:"rights_table" ORDER BY id;

SELECT json_build_array('responsibility',id,article_id,article_revision_id,revision_no,responsibility_version,previous_snapshot_id,
    created_at::timestamp,encode(sha256(convert_to(json_build_array(inherit_site_author=:flag_value,authors_json,reviewer_json,sources_json,
        update_summary,update_reason,effective_at::timestamp,conclusion_impact,methodology,applicability,limitations,
        responsible_person_confirmed=:flag_value)::text,'UTF8')),'hex'))
FROM :"custody_schema".:"responsibility_table" ORDER BY id;

SELECT json_build_array('event',id,event_id,aggregate_type,aggregate_id,schema_version,article_revision_id,revision_no,
    rights_snapshot_id,responsibility_snapshot_id,responsibility_version,article_publication_id,publication_no,event_type,
    status,retry_count,created_at::timestamp,next_retry_at::timestamp,processed_at::timestamp,
    encode(sha256(convert_to(payload_json,'UTF8')),'hex'))
FROM :"custody_schema".:"event_table" ORDER BY id;

SELECT json_build_array('edge',g.id,g.outbox_event_id,g.edge_name,g.status,g.attempt_count,g.updated_at::timestamp,g.delivery_key,
    g.delivery_key=encode(sha256(convert_to(e.event_id||':'||g.edge_name,'UTF8')),'hex'),g.last_error)
FROM :"custody_schema".:"edge_table" g LEFT JOIN :"custody_schema".:"event_table" e ON e.id=g.outbox_event_id ORDER BY g.id;

ROLLBACK;
