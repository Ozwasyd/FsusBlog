\set ON_ERROR_STOP on
\if :nightly
\set articles 100000
\set lifecycle 5000
\set roots 500000
\set replies 500000
\set hot_rows 20000
\set wide 480
\set chain_start 481
\set private_start 516
\else
\set articles 20
\set lifecycle 1
\set roots 48
\set replies 84
\set hot_rows 68
\set wide 12
\set chain_start 13
\set private_start 48
\endif
\set comment_base 9007199254740993
\set owner 72654af7-cd13-4fe0-8bce-9a0c0266d908
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL statement_timeout TO '120s';

SELECT current_database()=:'database_name' AND current_setting('data_directory')=:'data_directory'
    AND inet_server_addr() IS NULL AND current_setting('listen_addresses')=''
    AND current_setting('session_replication_role')='origin'
    AND (SELECT count(*)=1 AND bool_and(singleton AND version=1) FROM public.v2_schema)
    AND (SELECT site_id=:'site_id'::uuid FROM public.authoring_recovery_site WHERE singleton) AS owned \gset
\if :owned
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly fixture readback does not target its owned PostgreSQL site'; END $$;
\endif

WITH bounds AS (
    SELECT :articles-4*:lifecycle AS last_ordinary, :articles-3*:lifecycle AS last_initial_schedule,
        :articles-2*:lifecycle AS last_pending_update, :articles-:lifecycle AS last_retracted
), intended AS (
    SELECT id, CASE WHEN id<=last_ordinary THEN 'published' WHEN id<=last_initial_schedule THEN 'scheduled'
        WHEN id<=last_pending_update THEN 'scheduled-update' WHEN id<=last_retracted THEN 'retracted' ELSE 'deleted' END kind,
        CASE WHEN id<=last_ordinary THEN id WHEN id>last_initial_schedule THEN id-:lifecycle END AS first_release,
        CASE WHEN id%8<4 THEN 1 ELSE 2+id*7%30 END AS category,
        CASE WHEN id%16<3 THEN 1 ELSE 2+id*37%126 END AS tag
    FROM generate_series(1,:articles) id CROSS JOIN bounds
), expected AS (
    SELECT *, CASE kind WHEN 'scheduled-update' THEN 5 WHEN 'retracted' THEN 4 WHEN 'deleted' THEN 4 ELSE 3 END AS revision,
        CASE WHEN kind IN ('published','scheduled-update') THEN 3 END AS published_revision,
        CASE WHEN kind IN ('scheduled','scheduled-update') THEN to_timestamp(:'due_unix_ms'::bigint/1000.0) END AS schedule_due
    FROM intended
), head AS (
    SELECT DISTINCT ON (article_id) * FROM public.article_publication_history ORDER BY article_id,event_no DESC
), defects AS (
    SELECT e.id AS expected_id,a.id AS actual_id
    FROM expected e FULL JOIN public.article a ON a.id=e.id
    LEFT JOIN public.article_publication p ON p.article_id=a.id
    LEFT JOIN public.article_schedule s ON s.article_id=a.id
    LEFT JOIN public.article_schedule_receipt receipt ON (receipt.actor_id,receipt.command_id)=(s.actor_id,s.command_id)
    LEFT JOIN public.article_command command ON (command.actor_id,command.command_id)=(s.actor_id,s.command_id)
    LEFT JOIN head h ON h.article_id=a.id
    LEFT JOIN public.article_revision current ON (current.article_id,current.revision)=(a.id,a.revision)
    LEFT JOIN public.article_revision_category category ON (category.article_id,category.revision)=(a.id,a.revision)
    LEFT JOIN public.article_revision_tag tag ON (tag.article_id,tag.revision)=(a.id,a.revision)
    WHERE a.id IS NULL OR e.id IS NULL OR a.owner_id IS DISTINCT FROM :'owner'::uuid
        OR a.revision IS DISTINCT FROM e.revision OR a.published_revision IS DISTINCT FROM e.published_revision
        OR a.deleted IS DISTINCT FROM (e.kind='deleted')
        OR a.publication_count IS DISTINCT FROM CASE WHEN e.first_release IS NULL THEN 0 ELSE 1 END
        OR (a.title,a.body) IS DISTINCT FROM (current.title,current.body)
        OR category.category_id IS DISTINCT FROM e.category OR tag.tag_id IS DISTINCT FROM e.tag
        OR p.revision IS DISTINCT FROM e.published_revision
        OR p.publication_id IS DISTINCT FROM (CASE WHEN e.published_revision=3 THEN e.first_release END)
        OR (p.article_id IS NOT NULL AND (p.publication_no<>1 OR p.published_at>statement_timestamp()))
        OR s.due_at IS DISTINCT FROM e.schedule_due
        OR (s.article_id IS NOT NULL AND (s.due_at<=statement_timestamp() OR s.revision IS DISTINCT FROM e.revision
            OR s.actor_id IS DISTINCT FROM a.owner_id
            OR s.generation<>1 OR receipt.due_at IS DISTINCT FROM e.schedule_due
            OR receipt.published_revision IS DISTINCT FROM coalesce(e.published_revision,0)
            OR (command.article_id,command.revision,command.title,command.body,command.published)
                IS DISTINCT FROM (a.id,a.revision,a.title,a.body,e.published_revision IS NOT NULL)))
        OR (e.kind='scheduled' AND h.article_id IS NOT NULL)
        OR (e.kind IN ('published','scheduled-update') AND (h.kind,h.reason,h.event_no,h.revision,h.publication_id)
            IS DISTINCT FROM ('publish','author-published',1,3::bigint,e.first_release::bigint))
        OR (e.kind IN ('retracted','deleted') AND (h.kind,h.reason,h.event_no,h.revision,h.supersedes_id)
            IS DISTINCT FROM (CASE WHEN e.kind='retracted' THEN 'retract' ELSE 'delete' END,
                CASE WHEN e.kind='retracted' THEN 'author-withdrew' ELSE 'author-deleted' END,2,4::bigint,e.first_release::bigint))
), totals AS (
    SELECT (SELECT count(*) FROM public.article) AS articles,
        (SELECT count(*) FROM public.article_publication) AS active,
        (SELECT count(*) FROM public.article_revision) AS revisions,
        (SELECT count(*) FROM public.article_command) AS commands,
        (SELECT count(*) FROM public.blog_outbox) AS outbox,
        (SELECT count(*) FROM public.article_revision_rights) AS revision_rights,
        (SELECT count(*) FROM public.article_publication_rights) AS publication_rights,
        (SELECT count(*) FROM public.article_publication_history) AS publication_history,
        (SELECT count(*) FROM public.article_publication_canonical) AS publication_canonical,
        (SELECT count(*) FROM public.article_revision_category) AS categories,
        (SELECT count(*) FROM public.article_revision_tag) AS tags,
        (SELECT count(*) FROM public.article_schedule) AS schedules,
        (SELECT count(*) FROM public.article_schedule_receipt) AS schedule_receipts,
        (SELECT count(*) FROM defects) AS coordinate_defects
)
SELECT articles=:articles AND active=:articles-3*:lifecycle AND coordinate_defects=0
    AND revisions=3*:articles+4*:lifecycle AND commands=revisions AND outbox=revisions AND revision_rights=revisions
    AND publication_rights=:articles-:lifecycle AND publication_canonical=publication_rights
    AND publication_history=:articles+:lifecycle
    AND categories=revisions-articles AND tags=categories AND schedules=2*:lifecycle AND schedule_receipts=schedules
    AND NOT EXISTS (SELECT FROM public.blog_outbox WHERE processed_at IS NOT NULL)
    AND (SELECT count(*)=1 AND bool_and(id=:'owner'::uuid AND enabled AND can_author AND generation=1) FROM public.blog_user)
    AND NOT EXISTS (SELECT FROM public.login_ticket) AND NOT EXISTS (SELECT FROM public.user_session)
    AS article_graph_ok, to_jsonb(totals) AS article_metrics FROM totals \gset
SELECT jsonb_build_object('kind','article-graph','actual',:'article_metrics'::jsonb);
\if :article_graph_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly native article states, history or schedule coordinates differ'; END $$;
\endif

WITH comments AS MATERIALIZED (
    SELECT c.article_id,c.id,c.parent_id,c.depth,c.moderation_status,c.deleted,c.author_mode,
        p.article_id IS NOT NULL AS article_visible,b.comment_id IS NOT NULL AS blocked
    FROM public.comment c
    LEFT JOIN public.article_publication p ON p.article_id=c.article_id
    LEFT JOIN public.comment_blocked_region b ON (b.article_id,b.comment_id)=(c.article_id,c.id)
), totals AS (
    SELECT count(*) AS rows, count(*) FILTER (WHERE parent_id IS NULL) AS roots,
        count(*) FILTER (WHERE parent_id IS NOT NULL) AS replies,
        count(DISTINCT id) AS distinct_ids,
        count(*) FILTER (WHERE article_id=1) AS hot_rows,
        count(*) FILTER (WHERE article_id=2) AS empty_rows,
        count(*) FILTER (WHERE NOT article_visible) AS inactive_rows,
        count(*) FILTER (WHERE article_visible AND moderation_status=1 AND NOT deleted AND NOT blocked) AS visible_content,
        count(*) FILTER (WHERE author_mode<>1) AS other_author_modes,
        count(*) FILTER (WHERE blocked) AS blocked_rows,
        max(depth) AS max_depth, min(id) AS first_id, max(id) AS last_id,
        count(*) FILTER (WHERE article_id=1 AND parent_id=:comment_base+1) AS wide_children
    FROM comments
), private_leaves AS (
    SELECT count(*) AS rows FROM comments c
    WHERE article_id=1 AND article_visible AND id BETWEEN :comment_base+:roots+:private_start
        AND :comment_base+:roots+:private_start+4
        AND (moderation_status<>1 OR deleted OR blocked)
        AND NOT EXISTS (SELECT FROM public.comment child WHERE child.article_id=c.article_id AND child.parent_id=c.id)
), private_roots AS (
    SELECT count(*) AS rows FROM comments c
    WHERE article_id=1 AND article_visible AND id BETWEEN :comment_base+3 AND :comment_base+5
        AND (moderation_status<>1 OR deleted OR blocked)
        AND EXISTS (SELECT FROM comments child WHERE child.article_id=c.article_id AND child.parent_id=c.id
            AND child.moderation_status=1 AND NOT child.deleted AND NOT child.blocked)
), spread AS (
    SELECT article_id,count(*) AS rows FROM comments WHERE article_visible AND article_id NOT IN (1,2) GROUP BY article_id
), distribution AS (
    SELECT count(*) AS articles,count(*) FILTER (WHERE rows=4) AS four_rows,
        count(*) FILTER (WHERE rows=10) AS ten_rows,count(*) FILTER (WHERE rows=12) AS twelve_rows
    FROM spread
)
SELECT t.rows=:roots+:replies AND t.distinct_ids=t.rows AND t.roots=:roots AND t.replies=:replies AND t.hot_rows=:hot_rows
    AND t.empty_rows=0 AND t.inactive_rows=4 AND t.visible_content=:roots+:replies-12 AND t.other_author_modes=0
    AND t.blocked_rows=2 AND t.max_depth=32 AND t.wide_children=:wide
    AND t.first_id=:comment_base+1 AND t.last_id=:comment_base+:roots+:replies
    AND leaves.rows=5 AND roots.rows=3 AND t.visible_content+roots.rows=:roots+:replies-9
    AND (CASE WHEN :nightly THEN spread.articles=84998 AND spread.ten_rows=19990 AND spread.twelve_rows=65008
              ELSE spread.articles=15 AND spread.four_rows=15 END)
    AND NOT EXISTS (SELECT FROM public.comment_submit_command)
    AND NOT EXISTS (SELECT FROM public.comment_account_owner)
    AND NOT EXISTS (SELECT FROM public.comment_moderation_log)
    AS comment_graph_ok, to_jsonb(t) || jsonb_build_object('structural_nodes',t.visible_content+roots.rows,
        'spread',to_jsonb(spread)) AS comment_metrics
FROM totals t CROSS JOIN private_leaves leaves CROSS JOIN private_roots roots CROSS JOIN distribution spread \gset
SELECT jsonb_build_object('kind','comment-graph','actual',:'comment_metrics'::jsonb);
\if :comment_graph_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly comment storage, visibility or thread sentinels differ'; END $$;
\endif

WITH samples(id) AS (
    VALUES (1),(2),(:articles-4*:lifecycle),(:articles-4*:lifecycle+1),(:articles-3*:lifecycle+1),
        (:articles-2*:lifecycle),(:articles-2*:lifecycle+1),(:articles-:lifecycle+1)
)
SELECT jsonb_build_object('kind','article-case','id',a.id,'revision',a.revision,'publicRevision',p.revision,
    'publicationId',p.publication_id,'historicalFirstPublicationId',h.publication_id,
    'category',category.category_id,'tag',tag.tag_id,'originalTitle',original.title,
    'originalBodySha256',encode(sha256(convert_to(original.body,'UTF8')),'hex'),
    'publicBodySha256',encode(sha256(convert_to(published.body,'UTF8')),'hex'),
    'currentBodySha256',encode(sha256(convert_to(a.body,'UTF8')),'hex'))
FROM (SELECT DISTINCT id FROM samples) sample JOIN public.article a ON a.id=sample.id
JOIN public.article_revision original ON (original.article_id,original.revision)=(a.id,1)
JOIN public.article_revision_category category ON (category.article_id,category.revision)=(a.id,a.revision)
JOIN public.article_revision_tag tag ON (tag.article_id,tag.revision)=(a.id,a.revision)
LEFT JOIN public.article_publication p ON p.article_id=a.id
LEFT JOIN public.article_revision published ON (published.article_id,published.revision)=(p.article_id,p.revision)
LEFT JOIN public.article_publication_history h ON h.article_id=a.id AND h.event_no=1
ORDER BY a.id;

WITH RECURSIVE deep(id,parent_id,depth) AS (
    SELECT id,parent_id,depth FROM public.comment WHERE article_id=1 AND id=:comment_base+:roots+:chain_start+31
    UNION ALL
    SELECT parent.id,parent.parent_id,parent.depth FROM public.comment parent JOIN deep ON parent.id=deep.parent_id
    WHERE parent.article_id=1
)
SELECT jsonb_build_object('kind','thread-case','root',min(id)::text,'target',max(id)::text,
    'ancestors',count(*)-1,'depth',max(depth)) FROM deep;
ROLLBACK;
