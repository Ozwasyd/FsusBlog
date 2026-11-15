-- Overlay the frozen production ArticleService rollback on the first two terminal publications.
INSERT INTO article_revision (id,article_id,revision_no,title,summary,cover_image_url,categoryid,tag_ids,
    content_block_id,markdown_content,diff_summary,created_by_admin_principal_id,rollback_source_revision_id,
    rollback_reason,created_at)
SELECT 5000000003,article_id,3,title,summary,cover_image_url,categoryid,tag_ids,content_block_id,markdown_content,
    'article updated',7,id,'Restore the original reviewed article','2026-10-03 00:00:00'
FROM article_revision WHERE id=5000000001;

-- The rollback gets fresh rights IDs and hashes with the original first-publish clock.
INSERT INTO article_rights_snapshot
SELECT 702,article_id,5000000003,3,article_rights_policy_id,enabled,license_type,copyright_holder,copyright_year,
    rights_statement,attribution_template,copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,
    proof_binding_enabled,canonical_url,'sha256:a4f71436ce850abf631705ee7dc75bcddce598fa09192f2ecdd4b5ce73456008',
    'sha256:59ff522fee7107c1425e02567f9da69b7490127539b4ca7eae4d2f62bf551cee','2026-10-03 00:00:00'
FROM article_rights_snapshot WHERE id=700;
UPDATE article_rights_policy p SET
    (enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,copy_policy,max_excerpt_chars,
        allow_code_copy,show_public_badge,proof_binding_enabled,updated_at) =
    (s.enabled,s.license_type,s.copyright_holder,s.copyright_year,s.rights_statement,s.attribution_template,s.copy_policy,
        s.max_excerpt_chars,s.allow_code_copy,s.show_public_badge,s.proof_binding_enabled,'2026-10-03 00:00:00')
FROM article_rights_snapshot s WHERE s.id=700 AND p.id=s.article_rights_policy_id;

-- The production responsibility clone obtains its own clock after the rollback transaction's main coordinate.
INSERT INTO article_responsibility_snapshot
SELECT 802,article_id,5000000003,3,1,NULL,inherit_site_author,authors_json,reviewer_json,sources_json,update_summary,update_reason,
    effective_at,conclusion_impact,methodology,applicability,limitations,responsible_person_confirmed,'2026-10-03 00:00:00.000005'
FROM article_responsibility_snapshot WHERE id=799;
INSERT INTO article_publication VALUES
    (900000003,42,3,5000000003,3,702,802,'rollback','2026-10-03 00:00:00','2026-10-03 00:00:00');
UPDATE article SET title='First',summary='First public summary',coverimageurl='',categoryid=11,
    current_revision_id=5000000003,current_publication_id=900000003,metadata_updated_at='2026-10-03 00:00:00',
    last_published_at='2026-10-03 00:00:00',public_updated_at='2026-10-03 00:00:00'
WHERE id=42;
UPDATE article_body SET markdown_content='first',updated_at='2026-10-03 00:00:00' WHERE article_id=42;
DELETE FROM article_tag WHERE articleid=42;
INSERT INTO article_tag VALUES (42,21);

INSERT INTO article_mutation_outbox (
    id,event_id,aggregate_type,aggregate_id,schema_version,article_revision_id,revision_no,rights_snapshot_id,
    responsibility_snapshot_id,responsibility_version,article_publication_id,publication_no,event_type,payload_json,
    status,retry_count,next_retry_at,created_at,processed_at
) VALUES (
    991000003,'7e26cc17bbd844a7807868e3633b177a','article',42,2,5000000003,3,702,802,1,900000003,3,'updated',
    '{"schemaVersion":2,"articleId":42,"eventType":"updated","articleRevisionId":5000000003,"revisionNo":3,"rightsSnapshotId":702,"responsibilitySnapshotId":802,"responsibilityVersion":1,"releaseId":900000003,"releaseNo":3,"publicUpdatedAt":"2026-10-03T00:00:00.0000007Z","occurredAt":"2026-10-03T00:00:00.0000007Z","before":{"categoryId":12,"tagIds":[22],"visibility":"published"},"after":{"categoryId":11,"tagIds":[21],"visibility":"published"}}',
    'processed',0,'2026-10-03 00:02:00','2026-10-03 00:00:00','2026-10-03 00:00:03'
);

INSERT INTO article_mutation_outbox_edge (id,outbox_event_id,edge_name,status,attempt_count,updated_at,delivery_key)
SELECT 991300000 + edges.sequence,event.id,edges.name,'completed',1,'2026-10-03 00:00:02',
       encode(sha256(convert_to(event.event_id || ':' || edges.name,'UTF8')),'hex')
FROM article_mutation_outbox event
CROSS JOIN (VALUES (1,'article-detail-aeds'),(2,'http-cache-invalidation'),(3,'public-aot-invalidation'),
    (4,'public-artifact-revocation'),(5,'public-hot-read'),(6,'search-projection'),(7,'taxonomy-projection')) edges(sequence,name)
WHERE event.id=991000003;
