-- Reconstruct the frozen production rollback, including first-publish rights binding.
UPDATE article_revision SET summary='Retained source summary',cover_image_url='' WHERE id=5000000001;
UPDATE article_revision SET summary='Second release summary',cover_image_url='' WHERE id=5000000002;
UPDATE article_rights_snapshot SET
    content_canonical_hash='sha256:1e82aa2683e32b7a3ee7d642241dd4c6c1cb04a2296220cdb7c0f54766b159a2',
    policy_hash='sha256:937322d6a4ff1b5c22a3aefbad87220e4b69cb3c0fa1e1825f348bfd9fb8c8dd'
WHERE id=700;
UPDATE article_rights_snapshot SET
    content_canonical_hash='sha256:8c47648b130c34d4a1655cb69b5d60d1c144bdee980584dd6e6882018ab8878b',
    policy_hash='sha256:3804628cf0973c6d94f1bebec21e31f532306e945961312de11fb834f2af0826'
WHERE id=701;
INSERT INTO article_revision (id,article_id,revision_no,title,summary,cover_image_url,categoryid,tag_ids,
    content_block_id,markdown_content,diff_summary,created_by_admin_principal_id,rollback_source_revision_id,rollback_reason,created_at)
VALUES (5000000004,42,4,'First','Retained source summary','',11,'21',100,'','article updated',7,5000000001,
    'Return to the original article text','2026-10-04 00:00:00');
INSERT INTO article_rights_snapshot
SELECT 702,article_id,5000000004,4,article_rights_policy_id,enabled,license_type,copyright_holder,copyright_year,
    rights_statement,attribution_template,copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled,
    canonical_url,'sha256:426ae4b3b4417d4774898da0e0ede2a2bb9c730e46ded070ef1410192c470e2b',
    'sha256:b253abfe0ff75ab67a99fa177f33e0cc436a01919c591d1d70ca3e020139fe86','2026-10-04 00:00:00'
FROM article_rights_snapshot WHERE id=700;
INSERT INTO article_responsibility_snapshot
SELECT 802,article_id,5000000004,4,1,NULL,inherit_site_author,authors_json,reviewer_json,sources_json,update_summary,update_reason,
    effective_at,conclusion_impact,methodology,applicability,limitations,responsible_person_confirmed,'2026-10-04 00:00:00'
FROM article_responsibility_snapshot WHERE id=799;
INSERT INTO article_publication
VALUES (900000003,42,3,5000000004,4,702,802,'rollback','2026-10-04 00:00:00','2026-10-04 00:00:00');
UPDATE article SET title='First',summary='Retained source summary',coverimageurl='',categoryid=11,
    current_revision_id=5000000004,current_publication_id=900000003,metadata_updated_at='2026-10-04 00:00:00',
    last_published_at='2026-10-04 00:00:00',public_updated_at='2026-10-04 00:00:00'
WHERE id=42;
UPDATE article_body SET markdown_content='first',updated_at='2026-10-04 00:00:00' WHERE article_id=42;
DELETE FROM article_tag WHERE articleid=42;
INSERT INTO article_tag VALUES (42,21);
