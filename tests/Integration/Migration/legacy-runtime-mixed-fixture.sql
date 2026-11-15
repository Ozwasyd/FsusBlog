-- An independent v1 immediate first publication alongside article 42's ordinary republish.
-- The two hashes bind article 43's exact bytes and coordinates under the frozen v1 framing.
INSERT INTO article (id,title,summary,coverimageurl,categoryid,createtime,metadata_updated_at,isdeleted,status,
    current_revision_id,current_publication_id,published_at,last_published_at,public_updated_at)
VALUES (43,'Independent masthead','Different first summary','',11,'2026-10-03','2026-10-03',false,2,
    5000000004,900000003,'2026-10-03','2026-10-03','2026-10-03');
INSERT INTO article_body VALUES (43,'first','2026-10-03');
INSERT INTO article_tag VALUES (43,21);
INSERT INTO article_revision VALUES
    (5000000004,43,1,'Independent masthead','Different first summary','',11,'21',100,'','initial publish',7,NULL,NULL,'2026-10-03');
INSERT INTO article_rights_policy VALUES
    (601,43,true,'all-rights-reserved','Fixture Author',2026,'Different article rights',NULL,
     'append-attribution',300,true,true,false,'2026-10-03','2026-10-03');
INSERT INTO article_rights_snapshot VALUES
    (702,43,5000000004,1,601,true,'all-rights-reserved','Fixture Author',2026,'Different article rights',NULL,
     'append-attribution',300,true,true,false,NULL,'sha256:fe6791a61fd75bdfa7df372205140e0f5245242db220aa2dbb6b8e25c7018296',
     'sha256:81850637f65da14e6ddbe7b62a723f147a206fbf2888050c2bf5063968d3b87b','2026-10-03');
INSERT INTO article_publication VALUES
    (900000003,43,1,5000000004,1,702,NULL,'immediate-publish','2026-10-03','2026-10-03');
INSERT INTO article_mutation_outbox (id,event_id,aggregate_type,aggregate_id,schema_version,article_revision_id,revision_no,
    rights_snapshot_id,article_publication_id,publication_no,event_type,payload_json,status,retry_count,next_retry_at,created_at,processed_at)
SELECT 991000003,'c9322b37dbe14c22894538bde234fc21','article',43,2,5000000004,1,702,900000003,1,'created',
    replace(replace(replace(replace(replace(payload_json,'"articleId":42','"articleId":43'),'5000000001','5000000004'),
        '"rightsSnapshotId":700','"rightsSnapshotId":702'),'900000001','900000003'),'2026-10-01T','2026-10-03T'),
    status,retry_count,next_retry_at+interval '2 days',created_at+interval '2 days',processed_at+interval '2 days'
FROM article_mutation_outbox WHERE id=991000001;
INSERT INTO article_mutation_outbox_edge (id,outbox_event_id,edge_name,status,attempt_count,updated_at,delivery_key)
SELECT id+200000,991000003,edge_name,status,attempt_count,updated_at+interval '2 days',
    encode(sha256(convert_to('c9322b37dbe14c22894538bde234fc21:' || edge_name,'UTF8')),'hex')
FROM article_mutation_outbox_edge WHERE outbox_event_id=991000001;
