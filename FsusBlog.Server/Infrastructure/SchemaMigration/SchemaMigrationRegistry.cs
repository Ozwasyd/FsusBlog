namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaMigrationRegistry
{
    IReadOnlyList<ISchemaMigrationDescriptor> GetDescriptors();
}

public sealed class SchemaMigrationRegistry : ISchemaMigrationRegistry
{
    private readonly IReadOnlyList<ISchemaMigrationDescriptor> _descriptors =
    [
        BuildUserSessionCompatPreMigration(),
        BuildCommentThreadCompatMigration(),
        BuildContentCompatMigration(),
        BuildCommentThreadIndexMigration(),
        BuildContentCleanupMigration(),
        BuildMessagingSplitMigration(),
        BuildUserSoftDeleteMigration(),
        BuildUserSessionFinalizeMigration(),
        BuildAuditLogMigration()
    ];

    public IReadOnlyList<ISchemaMigrationDescriptor> GetDescriptors() => _descriptors;

    private static ISchemaMigrationDescriptor BuildUserSessionCompatPreMigration()
        => new SchemaMigrationDescriptor(
            "20260418-pre-user-session-compat",
            "Backfill legacy sys_user_session expiration columns before CodeFirst sync.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user_session", "idleexpiresat", "timestamp NULL"),
                new EnsureColumnStep("sys_user_session", "absoluteexpiresat", "timestamp NULL"),
                new EnsureColumnStep("sys_user_session", "rememberme", "boolean NULL"),
                new RawSqlStep("""
                    DO $$
                    DECLARE
                        legacy_expression text := 'NULL';
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_user_session'
                        ) THEN
                            IF EXISTS (
                                SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'sys_user_session' AND column_name = 'expires_at'
                            ) THEN
                                legacy_expression := 'expires_at';
                            ELSIF EXISTS (
                                SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'sys_user_session' AND column_name = 'expiresat'
                            ) THEN
                                legacy_expression := 'expiresat';
                            END IF;

                            EXECUTE format(
                                'UPDATE sys_user_session
                                 SET idleexpiresat = COALESCE(idleexpiresat, %1$s, now() + interval ''7 day''),
                                     absoluteexpiresat = COALESCE(absoluteexpiresat, %1$s, now() + interval ''30 day''),
                                     rememberme = COALESCE(rememberme, false)
                                 WHERE idleexpiresat IS NULL
                                    OR absoluteexpiresat IS NULL
                                    OR rememberme IS NULL;',
                                legacy_expression
                            );
                        END IF;
                    END $$;
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildCommentThreadCompatMigration()
        => new SchemaMigrationDescriptor(
            "20260418-pre-comment-threading-compat",
            "Upgrade comment threading/delete columns before CodeFirst sync on legacy comment tables.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment", "parent_id", "bigint NULL"),
                new EnsureColumnStep("comment", "root_id", "bigint NULL"),
                new EnsureColumnStep("comment", "reply_to_user_id", "integer NULL"),
                new EnsureColumnStep("comment", "reply_to_comment_id", "bigint NULL"),
                new EnsureColumnStep("comment", "depth", "integer NOT NULL DEFAULT 0"),
                new EnsureColumnStep("comment", "is_deleted", "boolean NOT NULL DEFAULT false"),
                new EnsureColumnStep("comment", "delete_reason", "text NULL"),
                new EnsureColumnStep("comment", "delete_time", "timestamp NULL"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'comment'
                        ) THEN
                            UPDATE comment
                            SET depth = 0
                            WHERE depth IS NULL;

                            UPDATE comment
                            SET is_deleted = false
                            WHERE is_deleted IS NULL;
                        END IF;
                    END $$;
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildCommentThreadIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-comment-threading-indexes",
            "Align comment indexes to the current threading model.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_comment_article_root_id"),
                new DropIndexStep("idx_comment_article_parent_id"),
                new DropIndexStep("idx_comment_user_id"),
                new DropIndexStep("idx_comment_user_id_desc"),
                new CreateIndexStep(
                    "idx_comment_article_root_id",
                    "CREATE INDEX IF NOT EXISTS idx_comment_article_root_id ON comment(article_id, root_id, id ASC);"),
                new CreateIndexStep(
                    "idx_comment_article_parent_id",
                    "CREATE INDEX IF NOT EXISTS idx_comment_article_parent_id ON comment(article_id, parent_id, id DESC);"),
                new CreateIndexStep(
                    "idx_comment_user_id_desc",
                    "CREATE INDEX IF NOT EXISTS idx_comment_user_id_desc ON comment(user_id, id DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildContentCompatMigration()
        => new SchemaMigrationDescriptor(
            "20260418-pre-content-compat",
            "Create compatibility content tables and backfill legacy article/page content before CodeFirst sync.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_body",
                    """
                    CREATE TABLE IF NOT EXISTS article_body (
                        article_id integer PRIMARY KEY,
                        markdown_content text NOT NULL DEFAULT '',
                        updated_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new EnsureTableStep(
                    "page_content",
                    """
                    CREATE TABLE IF NOT EXISTS page_content (
                        slug varchar(64) PRIMARY KEY,
                        content text NOT NULL DEFAULT '',
                        updated_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new BackfillSqlStep("""
                    DO $$
                    DECLARE
                        timestamp_expression text := 'now()';
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'article'
                        ) THEN
                            IF EXISTS (
                                SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'article' AND column_name = 'create_time'
                            ) THEN
                                timestamp_expression := 'a.create_time';
                            ELSIF EXISTS (
                                SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'article' AND column_name = 'createtime'
                            ) THEN
                                timestamp_expression := 'a.createtime';
                            END IF;

                            IF EXISTS (
                                SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'article' AND column_name = 'content'
                            ) THEN
                                EXECUTE format(
                                    'INSERT INTO article_body(article_id, markdown_content, updated_at)
                                     SELECT a.id, COALESCE(a.content, ''''), COALESCE(%1$s, now())
                                     FROM article a
                                     WHERE NOT EXISTS (
                                         SELECT 1 FROM article_body b WHERE b.article_id = a.id
                                     );',
                                    timestamp_expression
                                );

                                EXECUTE format(
                                    'UPDATE article_body b
                                     SET markdown_content = COALESCE(a.content, ''''),
                                         updated_at = COALESCE(%1$s, now())
                                     FROM article a
                                     WHERE a.id = b.article_id
                                       AND (b.markdown_content IS NULL OR length(trim(b.markdown_content)) = 0)
                                       AND a.content IS NOT NULL
                                       AND length(trim(a.content)) > 0;',
                                    timestamp_expression
                                );
                            ELSE
                                EXECUTE format(
                                    'INSERT INTO article_body(article_id, markdown_content, updated_at)
                                     SELECT a.id, '''', COALESCE(%1$s, now())
                                     FROM article a
                                     WHERE NOT EXISTS (
                                         SELECT 1 FROM article_body b WHERE b.article_id = a.id
                                     );',
                                    timestamp_expression
                                );
                            END IF;
                        END IF;
                    END $$;
                    """),
                new BackfillSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_systemconfig'
                        ) THEN
                            INSERT INTO page_content(slug, content, updated_at)
                            SELECT lower(replace(substr(s.key, 6), '_', '-')), s.value, now()
                            FROM sys_systemconfig s
                            WHERE s.key LIKE 'Page_%'
                              AND NOT EXISTS (
                                SELECT 1 FROM page_content p
                                WHERE p.slug = lower(replace(substr(s.key, 6), '_', '-'))
                              );
                        END IF;
                    END $$;
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildContentCleanupMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-content-cleanup",
            "Finalize content migration, regenerate summaries, and delete legacy structures.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new BackfillSqlStep("""
                    UPDATE article
                    SET summary = substring(summary FROM 1 FOR 512)
                    WHERE summary IS NOT NULL AND length(summary) > 512;
                    """),
                new BackfillSqlStep("""
                    UPDATE article a
                    SET summary = substring(COALESCE(b.markdown_content, '') FROM 1 FOR 200)
                    FROM article_body b
                    WHERE a.id = b.article_id
                      AND (a.summary IS NULL OR length(trim(a.summary)) = 0);
                    """),
                new RawSqlStep("""
                    DELETE FROM sys_systemconfig
                    WHERE key LIKE 'Page_%';
                    """),
                new AssertSqlStep(
                    "Legacy Page_* system config entries should be deleted after backfill.",
                    """
                    DO $$
                    BEGIN
                        IF EXISTS (SELECT 1 FROM sys_systemconfig WHERE key LIKE 'Page_%') THEN
                            RAISE EXCEPTION 'Legacy Page_* entries still exist in sys_systemconfig.';
                        END IF;
                    END $$;
                    """),
                new DropColumnStep("article", "content")
            ]);

    private static ISchemaMigrationDescriptor BuildMessagingSplitMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-messaging-split",
            "Backfill legacy sys_message/sys_user_message into msg_* tables and drop the old tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new BackfillSqlStep("""
                    DO $$
                    DECLARE
                        timestamp_expression text := 'now()';
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_message'
                        ) THEN
                            IF EXISTS (
                                SELECT 1 FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = 'sys_message' AND column_name = 'createtime'
                            ) THEN
                                timestamp_expression := 'm.createtime';
                            END IF;

                            EXECUTE format(
                                'INSERT INTO msg_conversation(
                                     id, subject, initiatoruserid, status, issystemsource, sourcemessageid,
                                     createdbytype, createdbyid, createdat, updatedat, lastmessageat
                                 )
                                 SELECT
                                     m.id,
                                     substring(coalesce(m.title, '''') from 1 for 160),
                                     NULL,
                                     0,
                                     true,
                                     m.id,
                                     2,
                                     NULL,
                                     coalesce(%1$s, now()),
                                     coalesce(%1$s, now()),
                                     coalesce(%1$s, now())
                                 FROM sys_message m
                                 WHERE NOT EXISTS (SELECT 1 FROM msg_conversation c WHERE c.id = m.id);',
                                timestamp_expression
                            );

                            EXECUTE format(
                                'INSERT INTO msg_message(
                                     id, conversationid, sendertype, senderid, body, attachmentsmeta, isinternalnote, createdat
                                 )
                                 SELECT
                                     m.id,
                                     m.id,
                                     2,
                                     NULL,
                                     coalesce(m.content, ''''),
                                     NULL,
                                     false,
                                     coalesce(%1$s, now())
                                 FROM sys_message m
                                 WHERE NOT EXISTS (SELECT 1 FROM msg_message x WHERE x.id = m.id);',
                                timestamp_expression
                            );
                        END IF;
                    END $$;
                    """),
                new BackfillSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_user_message'
                        ) THEN
                            INSERT INTO msg_participant_state(
                                conversationid, userid, lastreadmessageid, unreadcount, muted, lastreadat, updatedat
                            )
                            SELECT
                                rel.messageid,
                                rel.userid::integer,
                                CASE WHEN rel.isread THEN rel.messageid ELSE NULL END,
                                CASE WHEN rel.isread THEN 0 ELSE 1 END,
                                false,
                                rel.readtime,
                                coalesce(rel.readtime, now())
                            FROM sys_user_message rel
                            WHERE NOT EXISTS (
                                SELECT 1
                                FROM msg_participant_state p
                                WHERE p.conversationid = rel.messageid
                                  AND p.userid = rel.userid::integer
                            );
                        END IF;
                    END $$;
                    """),
                new DropTableStep("sys_user_message"),
                new DropTableStep("sys_message")
            ]);

    private static ISchemaMigrationDescriptor BuildUserSoftDeleteMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-user-soft-delete",
            "Ensure sys_user soft-delete columns exist on legacy databases.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "deleted_at", "timestamp NULL"),
                new EnsureColumnStep("sys_user", "deleted_reason", "varchar(256) NULL")
            ]);

    private static ISchemaMigrationDescriptor BuildUserSessionFinalizeMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-user-session-finalize",
            "Finalize sys_user_session schema and remove legacy expiration columns.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    DECLARE
                        legacy_expression text := 'NULL';
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user_session' AND column_name = 'expires_at'
                        ) THEN
                            legacy_expression := 'expires_at';
                        ELSIF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user_session' AND column_name = 'expiresat'
                        ) THEN
                            legacy_expression := 'expiresat';
                        END IF;

                        EXECUTE format(
                            'UPDATE sys_user_session
                             SET idleexpiresat = COALESCE(idleexpiresat, %1$s, now() + interval ''7 day''),
                                 absoluteexpiresat = COALESCE(absoluteexpiresat, %1$s, now() + interval ''30 day''),
                                 rememberme = COALESCE(rememberme, false)
                             WHERE idleexpiresat IS NULL
                                OR absoluteexpiresat IS NULL
                                OR rememberme IS NULL;',
                            legacy_expression
                        );
                    END $$;
                    """),
                new RawSqlStep("""
                    ALTER TABLE sys_user_session ALTER COLUMN idleexpiresat SET NOT NULL;
                    ALTER TABLE sys_user_session ALTER COLUMN absoluteexpiresat SET NOT NULL;
                    ALTER TABLE sys_user_session ALTER COLUMN rememberme SET DEFAULT false;
                    ALTER TABLE sys_user_session ALTER COLUMN rememberme SET NOT NULL;
                    """),
                new DropColumnStep("sys_user_session", "expires_at"),
                new DropColumnStep("sys_user_session", "expiresat")
            ]);

    private static ISchemaMigrationDescriptor BuildAuditLogMigration()
        => new SchemaMigrationDescriptor(
            "20260418-post-audit-log",
            "Create structured audit log table and indexes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "sys_audit_log",
                    """
                    CREATE TABLE IF NOT EXISTS sys_audit_log (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        source varchar(64) NOT NULL,
                        type varchar(32) NOT NULL,
                        occurred_at_utc timestamp NOT NULL,
                        event_info text NOT NULL,
                        context_json jsonb NULL
                    );
                    """),
                new CreateIndexStep(
                    "idx_audit_occurred_at_desc",
                    "CREATE INDEX IF NOT EXISTS idx_audit_occurred_at_desc ON sys_audit_log(occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_source_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_source_time ON sys_audit_log(source, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_type_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_type_time ON sys_audit_log(type, occurred_at_utc DESC);")
            ]);
}
