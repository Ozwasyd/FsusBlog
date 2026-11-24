\set ON_ERROR_STOP on
\if :{?million_articles}
\else
\set million_articles false
\endif
\if :million_articles
\set articles 1000000
\set lifecycle 50000
\elif :nightly
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
\set archivist cb7c1f2b-fd4e-4cce-9b22-31e36b475c28
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
\if :million_articles
SET LOCAL statement_timeout TO '900s';
\else
SET LOCAL statement_timeout TO '120s';
\endif

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
        :articles-2*:lifecycle AS last_pending_update, :articles-:lifecycle AS last_archived
), intended AS (
    SELECT id, CASE WHEN id<=last_ordinary THEN 'published' WHEN id<=last_initial_schedule THEN 'scheduled'
        WHEN id<=last_pending_update THEN 'scheduled-update' WHEN id<=last_archived THEN 'archived' ELSE 'deleted' END kind,
        CASE WHEN id<=last_ordinary THEN id WHEN id>last_initial_schedule THEN id-:lifecycle END AS first_release,
        CASE WHEN id>last_pending_update AND id<=last_archived
            THEN :articles-:lifecycle+2*(id-last_pending_update) END AS archive_release,
        CASE WHEN id%8<4 THEN 1 ELSE 2+id*7%30 END AS category,
        CASE WHEN id%16<3 THEN 1 ELSE 2+id*37%126 END AS tag
    FROM generate_series(1,:articles) id CROSS JOIN bounds
), expected AS (
    SELECT *, CASE kind WHEN 'scheduled-update' THEN 5 WHEN 'archived' THEN 6 WHEN 'deleted' THEN 4 ELSE 3 END AS revision,
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
        OR a.publication_count IS DISTINCT FROM CASE e.kind WHEN 'scheduled' THEN 0 WHEN 'archived' THEN 3 ELSE 1 END
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
        OR (e.kind='deleted' AND (h.kind,h.reason,h.event_no,h.revision,h.supersedes_id)
            IS DISTINCT FROM ('delete','author-deleted',2,4::bigint,e.first_release::bigint))
), archive_outbox AS (
    SELECT article_id,count(*) AS rows FROM public.blog_outbox
    WHERE revision=6 AND kind='retract' GROUP BY article_id
), archive_defects AS (
    SELECT e.id FROM expected e
    LEFT JOIN public.admin_article_rollback receipt ON (receipt.article_id,receipt.revision)=(e.id,6)
    LEFT JOIN public.article_publication_history first_event ON (first_event.article_id,first_event.event_no)=(e.id,1)
    LEFT JOIN public.article_publication_history interim_event ON (interim_event.article_id,interim_event.event_no)=(e.id,2)
    LEFT JOIN head terminal ON terminal.article_id=e.id
    LEFT JOIN public.article_revision source ON (source.article_id,source.revision)=(e.id,3)
    LEFT JOIN public.article_revision interim ON (interim.article_id,interim.revision)=(e.id,5)
    LEFT JOIN public.article_revision archived ON (archived.article_id,archived.revision)=(e.id,6)
    LEFT JOIN public.article_publication_canonical original_facts ON original_facts.publication_id=first_event.publication_id
    LEFT JOIN public.article_publication_canonical interim_facts ON interim_facts.publication_id=interim_event.publication_id
    LEFT JOIN public.article_publication_canonical hidden_facts ON hidden_facts.publication_id=receipt.publication_id
    LEFT JOIN public.article_publication_rights rights ON rights.id=receipt.rights_snapshot_id
    LEFT JOIN public.article_revision_rights source_policy ON (source_policy.article_id,source_policy.revision)=(e.id,3)
    LEFT JOIN public.article_revision_rights archived_policy ON (archived_policy.article_id,archived_policy.revision)=(e.id,6)
    LEFT JOIN public.article_publication_responsibility source_link ON source_link.publication_id=first_event.publication_id
    LEFT JOIN public.article_publication_responsibility archived_link ON archived_link.publication_id=receipt.publication_id
    LEFT JOIN public.article_revision_responsibility source_responsibility ON source_responsibility.id=source_link.snapshot_id
    LEFT JOIN public.article_revision_responsibility archived_responsibility ON archived_responsibility.id=archived_link.snapshot_id
    LEFT JOIN archive_outbox outbox ON outbox.article_id=e.id
    WHERE e.kind='archived' AND (
        (receipt.principal_id,receipt.command_id,receipt.previous_revision,receipt.source_revision,receipt.revision)
            IS DISTINCT FROM (:'archivist'::uuid,(lpad(to_hex(e.id),8,'0')||'-3f55-4000-8000-000000000006')::uuid,5::bigint,3::bigint,6::bigint)
        OR (receipt.source_publication_id,receipt.previous_publication_id,receipt.publication_id,receipt.publication_no,
            receipt.destination,receipt.from_archive,receipt.reason) IS DISTINCT FROM
            (e.first_release::bigint,(e.archive_release-1)::bigint,e.archive_release::bigint,3,3,false,'Archive the reviewed nightly source release')
        OR (first_event.kind,first_event.reason,first_event.revision,first_event.publication_no,first_event.actor_id,first_event.publication_id)
            IS DISTINCT FROM ('publish','author-published',3::bigint,1,:'owner'::uuid,e.first_release::bigint)
        OR (interim_event.kind,interim_event.reason,interim_event.revision,interim_event.publication_no,interim_event.actor_id,
            interim_event.supersedes_id,interim_event.publication_id) IS DISTINCT FROM
            ('replace','author-replaced',5::bigint,2,:'owner'::uuid,e.first_release::bigint,(e.archive_release-1)::bigint)
        OR (terminal.kind,terminal.reason,terminal.event_no,terminal.revision,terminal.publication_no,
            terminal.admin_actor_id,terminal.admin_command_id,terminal.supersedes_id,terminal.happened_at) IS DISTINCT FROM
            ('retract','administrator-rollback-archived',3,6::bigint,3,:'archivist'::uuid,receipt.command_id,receipt.previous_publication_id,receipt.published_at)
        OR terminal.publication_id IS NOT NULL OR terminal.actor_id IS NOT NULL OR terminal.command_id IS NOT NULL
        OR NOT (first_event.happened_at<interim_event.happened_at AND interim_event.happened_at<terminal.happened_at
            AND terminal.happened_at<=statement_timestamp())
        OR (archived.title,archived.body) IS DISTINCT FROM (source.title,source.body)
        OR interim.title IS DISTINCT FROM 'Interim public release before archive '||lpad(e.id::text,6,'0')
        OR interim.body IS DISTINCT FROM 'Interim publication selected for archive: c11interim'||lpad(e.id::text,6,'0')||'.'
        OR (original_facts.article_id,original_facts.revision,original_facts.publication_no,original_facts.transition)
            IS DISTINCT FROM (e.id,3::bigint,1,'publish')
        OR (interim_facts.article_id,interim_facts.revision,interim_facts.publication_no,interim_facts.transition)
            IS DISTINCT FROM (e.id,5::bigint,2,'replace') OR hidden_facts.publication_id IS NOT NULL
        OR (rights.article_id,rights.revision,rights.publication_id) IS DISTINCT FROM (e.id,6::bigint,e.archive_release::bigint)
        OR source_policy.article_id IS NULL OR archived_policy.article_id IS NULL
        OR (to_jsonb(source_policy)-'revision') IS DISTINCT FROM (to_jsonb(archived_policy)-'revision')
        OR (source_link.article_id,source_link.revision) IS DISTINCT FROM (e.id,3::bigint)
        OR (archived_link.article_id,archived_link.revision,archived_link.snapshot_id)
            IS DISTINCT FROM (e.id,6::bigint,receipt.responsibility_snapshot_id)
        OR (source_responsibility.responsible_party,source_responsibility.basis,source_responsibility.reference,source_responsibility.recorded_by)
            IS DISTINCT FROM ('Nightly synthetic editor','Fixture custody of first public revision','c11-nightly-archive:'||e.id,current_user::text)
        OR (archived_responsibility.responsible_party,archived_responsibility.basis,archived_responsibility.reference,
            archived_responsibility.recorded_by,archived_responsibility.source_snapshot_id) IS DISTINCT FROM
            (source_responsibility.responsible_party,source_responsibility.basis,source_responsibility.reference,
                source_responsibility.recorded_by,source_link.snapshot_id)
        OR source_responsibility.source_snapshot_id IS NOT NULL OR outbox.rows IS DISTINCT FROM 1::bigint
    )
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
        (SELECT count(*) FROM public.admin_article_rollback) AS archive_receipts,
        (SELECT count(*) FROM public.article_revision_responsibility) AS responsibility_snapshots,
        (SELECT count(*) FROM public.article_publication_responsibility) AS responsibility_links,
        (SELECT count(*) FROM public.article_revision_category) AS categories,
        (SELECT count(*) FROM public.article_revision_tag) AS tags,
        (SELECT count(*) FROM public.article_schedule) AS schedules,
        (SELECT count(*) FROM public.article_schedule_receipt) AS schedule_receipts,
        (SELECT count(*) FROM defects)+(SELECT count(*) FROM archive_defects) AS coordinate_defects
)
SELECT articles=:articles AND active=:articles-3*:lifecycle AND coordinate_defects=0
    AND revisions=3*:articles+6*:lifecycle AND commands=revisions-:lifecycle AND outbox=revisions AND revision_rights=revisions
    AND publication_rights=:articles+:lifecycle AND publication_canonical=:articles AND archive_receipts=:lifecycle
    AND publication_history=:articles+2*:lifecycle AND responsibility_snapshots=2*:lifecycle AND responsibility_links=responsibility_snapshots
    AND categories=revisions-articles AND tags=categories AND schedules=2*:lifecycle AND schedule_receipts=schedules
    AND NOT EXISTS (SELECT FROM public.blog_outbox WHERE processed_at IS NOT NULL)
    AND NOT EXISTS (SELECT FROM public.blog_user)
    AND NOT EXISTS (SELECT FROM public.login_ticket) AND NOT EXISTS (SELECT FROM public.user_session)
    AND (SELECT count(*)=2
        AND count(*) FILTER (WHERE id=:'owner'::uuid AND enabled AND generation=1)=1
        AND count(*) FILTER (WHERE id=:'archivist'::uuid AND handle='nightly-fixture-archive' AND NOT enabled AND generation=2)=1
        FROM public.admin_principal)
    AND NOT EXISTS (SELECT FROM public.admin_session) AND NOT EXISTS (SELECT FROM public.admin_passkey_credential)
    AND NOT EXISTS (SELECT FROM public.admin_invitation)
    AND NOT EXISTS (SELECT FROM public.admin_challenge) AND NOT EXISTS (SELECT FROM public.admin_article_rollback_step_up)
    AS article_graph_ok, to_jsonb(totals) AS article_metrics FROM totals \gset
SELECT jsonb_build_object('kind','article-graph','actual',:'article_metrics'::jsonb);
\if :article_graph_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly native article states, history or schedule coordinates differ'; END $$;
\endif

\if :million_articles
WITH totals AS (
    SELECT count(*) AS rows, count(*) FILTER (WHERE parent_id IS NULL) AS roots,
        count(*) FILTER (WHERE parent_id IS NOT NULL) AS replies, count(*) AS visible_content,
        count(*) AS structural_nodes FROM public.comment
)
SELECT rows=0 AND NOT EXISTS (SELECT FROM public.comment_blocked_region)
    AND NOT EXISTS (SELECT FROM public.comment_submit_command)
    AND NOT EXISTS (SELECT FROM public.comment_account_owner)
    AND NOT EXISTS (SELECT FROM public.comment_moderation_log)
    AS comment_graph_ok, to_jsonb(totals) AS comment_metrics FROM totals \gset
\else
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
        count(*) FILTER (WHERE NOT article_visible AND article_id=:articles-2*:lifecycle+1) AS archived_rows,
        count(*) FILTER (WHERE NOT article_visible AND article_id=:articles-:lifecycle+1) AS deleted_rows,
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
    AND t.empty_rows=0 AND t.inactive_rows=4 AND t.archived_rows=2 AND t.deleted_rows=2
    AND t.visible_content=:roots+:replies-12 AND t.other_author_modes=0
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
\endif
SELECT jsonb_build_object('kind','comment-graph','actual',:'comment_metrics'::jsonb);
\if :comment_graph_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'Nightly comment storage, visibility or thread sentinels differ'; END $$;
\endif

WITH samples(id) AS (
    VALUES (1),(2),(:articles-4*:lifecycle),(:articles-4*:lifecycle+1),(:articles-3*:lifecycle+1),
        (:articles-2*:lifecycle),(:articles-2*:lifecycle+1),(:articles-:lifecycle),(:articles-:lifecycle+1)
    UNION ALL SELECT :articles WHERE :million_articles
)
SELECT jsonb_build_object('kind','article-case','id',a.id,'revision',a.revision,'publicRevision',p.revision,
    'publicationId',p.publication_id,'historicalFirstPublicationId',h.publication_id,
    'archiveSupersededReleaseId',archive.previous_publication_id,'archivedReleaseId',archive.publication_id,
    'category',category.category_id,'tag',tag.tag_id,'originalTitle',original.title,
    'originalBodySha256',encode(sha256(convert_to(original.body,'UTF8')),'hex'),
    'publicBodySha256',encode(sha256(convert_to(published.body,'UTF8')),'hex'),
    'archiveInterimBodySha256',encode(sha256(convert_to(interim.body,'UTF8')),'hex'),
    'currentBodySha256',encode(sha256(convert_to(a.body,'UTF8')),'hex'))
FROM (SELECT DISTINCT id FROM samples) sample JOIN public.article a ON a.id=sample.id
JOIN public.article_revision original ON (original.article_id,original.revision)=(a.id,1)
JOIN public.article_revision_category category ON (category.article_id,category.revision)=(a.id,a.revision)
JOIN public.article_revision_tag tag ON (tag.article_id,tag.revision)=(a.id,a.revision)
LEFT JOIN public.article_publication p ON p.article_id=a.id
LEFT JOIN public.article_revision published ON (published.article_id,published.revision)=(p.article_id,p.revision)
LEFT JOIN public.article_publication_history h ON h.article_id=a.id AND h.event_no=1
LEFT JOIN public.admin_article_rollback archive ON (archive.article_id,archive.revision)=(a.id,a.revision)
LEFT JOIN public.article_revision interim ON (interim.article_id,interim.revision)=(a.id,archive.previous_revision)
ORDER BY a.id;

\if :million_articles
\else
WITH RECURSIVE deep(id,parent_id,depth) AS (
    SELECT id,parent_id,depth FROM public.comment WHERE article_id=1 AND id=:comment_base+:roots+:chain_start+31
    UNION ALL
    SELECT parent.id,parent.parent_id,parent.depth FROM public.comment parent JOIN deep ON parent.id=deep.parent_id
    WHERE parent.article_id=1
)
SELECT jsonb_build_object('kind','thread-case','root',min(id)::text,'target',max(id)::text,
    'ancestors',count(*)-1,'depth',max(depth)) FROM deep;
\endif
ROLLBACK;
