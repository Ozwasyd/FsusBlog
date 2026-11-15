-- The restored third publication stays current during all four responsibility edits of historical revision 2.
INSERT INTO public.article_responsibility_snapshot (
    id,article_id,article_revision_id,revision_no,responsibility_version,previous_snapshot_id,inherit_site_author,
    authors_json,reviewer_json,sources_json,update_summary,update_reason,effective_at,conclusion_impact,methodology,
    applicability,limitations,responsible_person_confirmed,created_at
) VALUES
    (803,42,5000000002,2,1,NULL,true,'[{"name":"Archive Reviewer","profileUrl":null}]',NULL,'[]',
     'Historical review',NULL,NULL,NULL,NULL,NULL,NULL,true,'2026-10-04 12:30:00'),
    (804,42,5000000002,2,2,803,true,'[{"name":"Archive Reviewer","profileUrl":"https://archive.example/reviewer"}]',NULL,'[]',
     'Historical review expanded','Updated historical source review',NULL,'clarified',NULL,NULL,NULL,true,'2026-10-05 13:45:00'),
    (805,42,5000000002,2,3,804,true,'[{"name":"Archive Reviewer","profileUrl":"https://archive.example/reviewer"}]',NULL,'[]',
     'Historical review verified','Verified document inventory',NULL,'none',NULL,NULL,NULL,true,'2026-10-06 09:10:00'),
    (806,42,5000000002,2,4,805,true,'[{"name":"Archive Editor","profileUrl":"https://archive.example/editor"}]',NULL,'[]',
     'Historical review finalized','Recorded final review owner',NULL,'clarified',NULL,NULL,NULL,true,'2026-10-07 08:15:00');

-- The frozen producer sets release coordinates to null, takes rights from current p3 and repeats the old revision scope.
WITH edits(id,event_id,snapshot_id,version,happened_at,occurred_at) AS (
    VALUES (991000004,'44000000000040008000000000000001',803,1,timestamp '2026-10-04 12:30:00','2026-10-04T12:30:00Z'),
           (991000005,'44000000000040008000000000000002',804,2,timestamp '2026-10-05 13:45:00','2026-10-05T13:45:00Z'),
           (991000006,'44000000000040008000000000000003',805,3,timestamp '2026-10-06 09:10:00','2026-10-06T09:10:00Z'),
           (991000007,'44000000000040008000000000000004',806,4,timestamp '2026-10-07 08:15:00','2026-10-07T08:15:00Z')
)
INSERT INTO public.article_mutation_outbox (
    id,event_id,aggregate_type,aggregate_id,schema_version,article_revision_id,revision_no,rights_snapshot_id,
    responsibility_snapshot_id,responsibility_version,article_publication_id,publication_no,event_type,payload_json,
    status,retry_count,next_retry_at,created_at,processed_at
)
SELECT id,event_id,'article',42,2,5000000002,2,702,snapshot_id,version,NULL,NULL,'responsibility-updated',
    format('{"schemaVersion":2,"articleId":42,"eventType":"responsibility-updated","articleRevisionId":5000000002,"revisionNo":2,"rightsSnapshotId":702,"responsibilitySnapshotId":%s,"responsibilityVersion":%s,"releaseId":null,"releaseNo":null,"publicUpdatedAt":"2026-10-03T00:00:00Z","occurredAt":"%s","before":{"categoryId":12,"tagIds":[22],"visibility":"historical"},"after":{"categoryId":12,"tagIds":[22],"visibility":"historical"}}',
        snapshot_id,version,occurred_at),
    'processed',0,happened_at,happened_at,happened_at + interval '2 seconds'
FROM edits ORDER BY id;

-- The frozen dispatcher preflight skips all required and optional edges before running any live side effects.
INSERT INTO public.article_mutation_outbox_edge (id,outbox_event_id,edge_name,status,attempt_count,last_error,updated_at,delivery_key)
SELECT 991300000 + (event.id - 991000003) * 100000 + edges.sequence,event.id,edges.name,'skipped',1,
    'superseded-by-revision:5000000003',event.created_at + interval '1 second',
    encode(sha256(convert_to(event.event_id || ':' || edges.name,'UTF8')),'hex')
FROM public.article_mutation_outbox event
CROSS JOIN (VALUES (1,'article-detail-aeds'),(2,'http-cache-invalidation'),(3,'integrity-proof'),(4,'notification'),
    (5,'public-aot-invalidation'),(6,'public-artifact-revocation'),(7,'public-hot-read'),(8,'search-projection'),(9,'taxonomy-projection'))
    edges(sequence,name)
WHERE event.id IN (991000004,991000005,991000006,991000007)
ORDER BY event.id,edges.sequence;
