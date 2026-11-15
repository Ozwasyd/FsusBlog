-- A second reviewed author with a never-published historical revision and a different current draft.
INSERT INTO admin_principal VALUES (8, 'fixture-second-author', 'active', 1, false, '[]', false, NULL);
INSERT INTO article (id,title,categoryid,createtime,metadata_updated_at,isdeleted,status,current_revision_id)
VALUES (43,'Second private draft',12,'2026-10-05','2026-10-06',false,0,5000000005);
INSERT INTO article_body VALUES (43,'second current body','2026-10-06');
INSERT INTO article_tag VALUES (43,22);
INSERT INTO article_revision_content_block
SELECT id,encode(sha256(convert_to(body,'UTF8')),'hex'),body,octet_length(body),created::timestamp
FROM (VALUES (400,'second historical body','2026-10-05'),(500,'second current body','2026-10-06')) v(id,body,created);
INSERT INTO article_revision (id,article_id,revision_no,title,categoryid,tag_ids,content_block_id,
    markdown_content,created_by_admin_principal_id,created_at)
VALUES (5000000004,43,1,'Second private history',12,'22',400,'',8,'2026-10-05'),
       (5000000005,43,2,'Second private draft',12,'22',500,'',8,'2026-10-06');
INSERT INTO content_asset VALUES
    (:'historical_asset','private',:'historical_key','image/png','.png',:historical_bytes,:'historical_sha',2,2,8,'active','2026-10-05','2026-10-05'),
    (:'current_asset','private',:'current_key','image/jpeg','.jpeg',:current_bytes,:'current_sha',2,2,8,'active','2026-10-06','2026-10-06');
INSERT INTO content_asset_reference VALUES
    (:'historical_asset','revision','5000000004',43,1,'历史附件','2026-10-05'),
    (:'current_asset','revision','5000000004',43,1,'Previous second owner','2026-10-05'),
    (:'current_asset','revision','5000000005',43,1,'Current second owner','2026-10-06');
