-- Recheck the real owner, graph inventory, revision history and unchanged source
-- article counts outside the browser session before the disposable DB is stopped.
DO $verify$
DECLARE
    graph_id uuid;
BEGIN
    SELECT c.id INTO STRICT graph_id
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
END $verify$;

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
