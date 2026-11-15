-- Overlay the frozen ArticleService ordinary-update shape on the processed-create fixture.
UPDATE article_mutation_outbox SET payload_json=replace(payload_json,'.0000007Z','Z') WHERE id=991000001;
DELETE FROM article_mutation_outbox_edge WHERE edge_name='notification';

-- Ordinary republish uses the current article's original first-publish timestamp in its rights snapshot.
-- The event and second release coordinates use the actual update time. The fresh revision has no responsibility.
INSERT INTO admin_principal VALUES (8,'fixture-republisher','active',1,false,'[]',false,NULL);
UPDATE article_revision SET summary='First public summary',cover_image_url='' WHERE id=5000000001;
UPDATE article_revision SET summary='Second public summary',cover_image_url='',categoryid=12,tag_ids='22',
    created_by_admin_principal_id=8 WHERE id=5000000002;
UPDATE article_rights_snapshot SET
    content_canonical_hash='sha256:1b00967ee80d2196db2cbc97ad219ad45806ea481d31a7dde8c93b73749773b6',
    policy_hash='sha256:d742b951390b08022d11f1987744f7760a50728db4c5253687d539588a3d1622'
WHERE id=700;
UPDATE article_rights_snapshot SET
    content_canonical_hash='sha256:361987dad74f14fef450a416c7f360af5859fd71b246ae1b20ab46eedf9fb7f1',
    policy_hash='sha256:d9f7700776f8c52f834e43e4f4d3270790b6a25ace06696802244346f7310591'
WHERE id=701;
UPDATE article_publication SET responsibility_snapshot_id=NULL WHERE id=900000002;
DELETE FROM article_responsibility_snapshot WHERE id IN (800,801);
UPDATE article SET title='Public',summary='Second public summary',coverimageurl='',categoryid=12,
    current_revision_id=5000000002,metadata_updated_at='2026-10-02 00:00:00'
WHERE id=42;
UPDATE article_body SET markdown_content='published ☃',updated_at='2026-10-02 00:00:00' WHERE article_id=42;
DELETE FROM article_tag WHERE articleid=42 AND tagid<>22;
DELETE FROM article_revision WHERE id=5000000003;
DELETE FROM article_revision_content_block WHERE id=300;

INSERT INTO article_mutation_outbox (
    id,event_id,aggregate_type,aggregate_id,schema_version,article_revision_id,revision_no,rights_snapshot_id,
    article_publication_id,publication_no,event_type,payload_json,status,retry_count,next_retry_at,created_at,processed_at
) VALUES (
    991000002,'edc88d1bf67a4b47bc222b9b93cc41da','article',42,2,5000000002,2,701,900000002,2,'updated',
    '{"schemaVersion":2,"articleId":42,"eventType":"updated","articleRevisionId":5000000002,"revisionNo":2,"rightsSnapshotId":701,"responsibilitySnapshotId":null,"responsibilityVersion":null,"releaseId":900000002,"releaseNo":2,"publicUpdatedAt":"2026-10-02T00:00:00.0000007Z","occurredAt":"2026-10-02T00:00:00.0000007Z","before":{"categoryId":11,"tagIds":[21],"visibility":"published"},"after":{"categoryId":12,"tagIds":[22],"visibility":"published"}}',
    'processed',0,'2026-10-02 00:02:00','2026-10-02 00:00:00','2026-10-02 00:00:03'
);

INSERT INTO article_mutation_outbox_edge (id,outbox_event_id,edge_name,status,attempt_count,updated_at,delivery_key)
SELECT 991200000 + edges.sequence,event.id,edges.name,'completed',1,'2026-10-02 00:00:02',
       encode(sha256(convert_to(event.event_id || ':' || edges.name,'UTF8')),'hex')
FROM article_mutation_outbox event
CROSS JOIN (VALUES (1,'article-detail-aeds'),(2,'http-cache-invalidation'),(3,'public-aot-invalidation'),
    (4,'public-artifact-revocation'),(5,'public-hot-read'),(6,'search-projection'),(7,'taxonomy-projection')) edges(sequence,name)
WHERE event.id=991000002;
