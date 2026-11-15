-- Overlay the three legacy intake fixtures with one immediate first publication made by ArticleService.
-- Frozen v1 2605b438eed8f16d12ddddf033d08a6fa18fcd12, src/backend/Services/ArticleService.cs:739-830.
DELETE FROM article_publication WHERE id=900000002;
DELETE FROM article_responsibility_snapshot WHERE id=801;
DELETE FROM article_responsibility_snapshot WHERE id=800;
DELETE FROM article_responsibility_snapshot WHERE id=799;
DELETE FROM article_rights_snapshot WHERE id=701;
DELETE FROM article_revision WHERE id IN (5000000002,5000000003);
DELETE FROM article_revision_content_block WHERE id IN (200,300);

UPDATE article SET title='Legacy first publication',summary='Verified starlight rehearsal.',coverimageurl='',
    categoryid=11,current_revision_id=5000000001,current_publication_id=900000001,
    metadata_updated_at=createtime,last_published_at=published_at,public_updated_at=published_at
WHERE id=42;
UPDATE article_body SET markdown_content='Verified starlight rehearsal.',updated_at=TIMESTAMP '2026-10-01 00:00:00'
WHERE article_id=42;
UPDATE article_revision SET title='Legacy first publication',summary='Verified starlight rehearsal.',cover_image_url='',
    diff_summary='initial publish'
WHERE id=5000000001;
UPDATE article_revision_content_block SET markdown_content='Verified starlight rehearsal.',byte_length=29,
    content_hash='d9528f68206a6e8ef49a404110ebb5f08f2f2d28582454a6a98027e81bb7339c'
WHERE id=100;

DELETE FROM article_tag WHERE articleid=42;
INSERT INTO article_tag VALUES (42,21);
DELETE FROM tag_url_alias WHERE tag_id=23;
DELETE FROM tag WHERE id IN (22,23);
DELETE FROM category WHERE id=12;

-- The digest literals independently reproduce the frozen v1 canonical content and policy payloads.
UPDATE article_rights_snapshot SET rights_statement='Retained fixture rights.',attribution_template='{title} {url}',
    proof_binding_enabled=false,
    content_canonical_hash='sha256:084579db04e379c29f4260cd8dba91bd8d7a5c96b74ee1c02a25b77e5f662fc0',
    policy_hash='sha256:52a8ac6cd4cb01b21a43d75647921e0237bb7ea0669e557f807517692fe04fc9'
WHERE id=700;
UPDATE article_rights_policy policy SET
    (enabled,license_type,copyright_holder,copyright_year,rights_statement,attribution_template,copy_policy,max_excerpt_chars,
        allow_code_copy,show_public_badge,proof_binding_enabled,updated_at)=
    (snapshot.enabled,snapshot.license_type,snapshot.copyright_holder,snapshot.copyright_year,snapshot.rights_statement,
        snapshot.attribution_template,snapshot.copy_policy,snapshot.max_excerpt_chars,snapshot.allow_code_copy,
        snapshot.show_public_badge,snapshot.proof_binding_enabled,snapshot.created_at)
FROM article_rights_snapshot snapshot WHERE snapshot.id=700 AND policy.id=snapshot.article_rights_policy_id;

-- Every required edge completed before the dispatcher processed the event. No optional edge was recorded.
DELETE FROM article_mutation_outbox_edge WHERE outbox_event_id=991000001 AND edge_name='notification';
UPDATE article_mutation_outbox SET next_retry_at=created_at,processed_at=TIMESTAMP '2026-10-01 00:02:01',
    payload_json=replace(payload_json,'2026-10-01T00:00:00.0000007Z','2026-10-01T00:00:00Z')
WHERE id=991000001;
