-- Verify both sides of the committed link outside the browser session.
DO $verify$
DECLARE
    graph_id uuid;
    actor uuid;
    source_article public.article%ROWTYPE;
    target_article public.article%ROWTYPE;
    link_plan public.canvas_link_plan%ROWTYPE;
    source_revision public.article_revision%ROWTYPE;
    tail text;
BEGIN
    SELECT c.id,c.owner_id INTO STRICT graph_id,actor
    FROM public.authoring_canvas c JOIN public.blog_user a ON a.id=c.owner_id
    WHERE a.name='browser-author' AND c.title='Canvas scale 10000 nodes and edges' AND NOT c.deleted
    ORDER BY c.touched_at DESC LIMIT 1;
    IF EXISTS (
        SELECT FROM public.authoring_canvas c JOIN public.blog_user a ON a.id=c.owner_id
        WHERE a.name='canvas-scale-outsider'
    ) OR (SELECT count(*) FROM public.canvas_node WHERE canvas_id=graph_id) <> 10000
       OR (SELECT count(*) FROM public.canvas_edge WHERE canvas_id=graph_id) <> 10000
       OR (SELECT count(*) FROM public.canvas_history_transition WHERE canvas_id=graph_id) < 3
    THEN
        RAISE EXCEPTION 'Canvas scale durable counts, ownership or history failed';
    END IF;

    SELECT * INTO STRICT source_article FROM public.article
    WHERE owner_id=actor AND title='Canvas scale source';
    SELECT * INTO STRICT target_article FROM public.article
    WHERE owner_id=actor AND title='Canvas scale target';
    SELECT * INTO STRICT link_plan FROM public.canvas_link_plan
    WHERE canvas_id=graph_id AND applied_revision IS NOT NULL;
    SELECT * INTO STRICT source_revision FROM public.article_revision
    WHERE article_id=source_article.id AND revision=link_plan.host_revision;
    tail := E'\n\n[Canvas scale target](/article/' || target_article.id || ')';

    IF source_article.body IS DISTINCT FROM source_revision.body || tail
       OR source_article.revision <> link_plan.host_revision + 1
       OR source_article.published_revision IS DISTINCT FROM link_plan.host_revision
       OR target_article.revision <> link_plan.target_revision
       OR target_article.published_revision IS DISTINCT FROM link_plan.target_revision
       OR link_plan.applied_article_id IS DISTINCT FROM source_article.id
       OR link_plan.applied_revision IS DISTINCT FROM source_article.revision
       OR link_plan.applied_canvas_revision IS DISTINCT FROM link_plan.canvas_revision + 1
       OR link_plan.insert_digest IS DISTINCT FROM sha256(convert_to(tail,'UTF8'))
       OR NOT EXISTS (
           SELECT FROM public.canvas_edge e
           JOIN public.canvas_node s ON s.canvas_id=e.canvas_id AND s.id=e.source_node_id
           JOIN public.canvas_node t ON t.canvas_id=e.canvas_id AND t.id=e.target_node_id
           WHERE e.canvas_id=graph_id AND e.id=link_plan.edge_id AND e.explicit_reference
             AND s.article_id=source_article.id AND t.article_id=target_article.id
       )
       OR (SELECT count(*) FROM public.canvas_document_event e
           WHERE e.canvas_id=graph_id AND e.command_kind=3 AND e.command_id=link_plan.id
             AND e.actor_id=actor AND e.revision=link_plan.applied_canvas_revision
             AND e.fingerprint=link_plan.insert_digest) <> 1
       OR (SELECT count(*) FROM public.article_command c
           WHERE c.actor_id=actor AND c.command_id=link_plan.id AND c.article_id=source_article.id
             AND c.revision=source_article.revision) <> 1
       OR (SELECT count(*) FROM public.blog_outbox o
           WHERE o.article_id=source_article.id AND o.revision=source_article.revision AND o.kind='save') <> 1
       OR (SELECT count(*) FROM public.article_publication p
           WHERE (p.article_id,p.revision) IN ((source_article.id,link_plan.host_revision),
                                              (target_article.id,link_plan.target_revision))) <> 2
    THEN
        RAISE EXCEPTION 'Canvas scale link must preserve publication and commit the exact revision, event and outbox once';
    END IF;
END $verify$;

SELECT p.id AS link_plan,p.host_revision,p.target_revision,p.applied_revision,p.applied_canvas_revision,
       encode(p.insert_digest,'hex') AS inserted_sha256
FROM public.canvas_link_plan p JOIN public.authoring_canvas c ON c.id=p.canvas_id
WHERE c.title='Canvas scale 10000 nodes and edges' AND p.applied_revision IS NOT NULL;

SELECT c.revision, e.node_count, e.edge_count, c.viewport_x, c.viewport_y, c.viewport_zoom
FROM public.authoring_canvas c JOIN public.canvas_document_event e ON e.canvas_id=c.id AND e.revision=c.revision
JOIN public.blog_user a ON a.id=c.owner_id
WHERE a.name='browser-author' AND c.title='Canvas scale 10000 nodes and edges' AND NOT c.deleted
ORDER BY c.touched_at DESC;

SELECT n.kind,count(*)
FROM public.canvas_node n JOIN public.authoring_canvas c ON c.id=n.canvas_id
WHERE c.title='Canvas scale 10000 nodes and edges' AND NOT c.deleted
GROUP BY n.kind ORDER BY n.kind;

SELECT e.explicit_reference,count(*)
FROM public.canvas_edge e JOIN public.authoring_canvas c ON c.id=e.canvas_id
WHERE c.title='Canvas scale 10000 nodes and edges' AND NOT c.deleted
GROUP BY e.explicit_reference ORDER BY e.explicit_reference;
