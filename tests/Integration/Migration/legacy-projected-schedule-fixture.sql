-- A first scheduled release captured before its due time with no prior publication.
-- The two snapshot digest literals follow the pinned canonical-v1 status and due-time rules.
INSERT INTO article (id,title,summary,coverimageurl,categoryid,createtime,metadata_updated_at,isdeleted,status,
    current_revision_id,scheduled_publish_at)
VALUES (43,'Scheduled first release','Verified scheduled text','',11,'2026-01-02 00:00:00','2026-01-02 00:00:00',false,1,
    5000000100,'2026-01-05 00:00:00');
INSERT INTO article_tag VALUES (43,21);
INSERT INTO article_body VALUES (43,'Scheduled body ☃','2026-01-02 00:00:00');
INSERT INTO article_revision_content_block VALUES
    (400,'41cc030068b52936d0254a43d41e53b087eef7a241d72b7227fefc7f27bdd7c5',
     'Scheduled body ☃',18,'2026-01-02 00:00:00');
INSERT INTO article_revision (id,article_id,revision_no,title,summary,cover_image_url,categoryid,tag_ids,
    content_block_id,markdown_content,diff_summary,created_by_admin_principal_id,created_at)
VALUES (5000000100,43,1,'Scheduled first release','Verified scheduled text','',11,'21',400,'',
    'initial publish',7,'2026-01-02 00:00:00');
INSERT INTO article_rights_policy VALUES
    (610,43,true,'CC-BY-4.0','Fixture Author',2026,'Scheduled rights','{title} {url}','append-attribution',
     120,false,true,true,'2026-01-02 00:00:00','2026-01-02 00:00:00');
INSERT INTO article_rights_snapshot VALUES
    (710,43,5000000100,1,610,true,'CC-BY-4.0','Fixture Author',2026,'Scheduled rights','{title} {url}','append-attribution',
     120,false,true,true,NULL,'sha256:2ccf94a403cb76da85af5583079c8cfda9c3305dd0ac83180d7fe92a2661268b',
     'sha256:0b2dd71755ade169d30b26153a3ea3d76bd2e048178657570af391f7d0303b82','2026-01-02 00:00:00');
INSERT INTO article_responsibility_snapshot VALUES
    (810,43,5000000100,1,1,NULL,true,'[]',NULL,'[]','Schedule review',NULL,NULL,NULL,NULL,NULL,NULL,true,
     '2026-01-02 00:00:00');
