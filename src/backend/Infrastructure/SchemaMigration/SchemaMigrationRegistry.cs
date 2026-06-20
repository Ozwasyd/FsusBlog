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
        BuildLegacy20260517ProfileCompatibilityMigration(),
        BuildContentCompatMigration(),
        BuildCommentThreadIndexMigration(),
        BuildContentCleanupMigration(),
        BuildMessagingSplitMigration(),
        BuildUserSoftDeleteMigration(),
        BuildUserSessionFinalizeMigration(),
        BuildUserAuthSecurityHardeningMigration(),
        BuildAnonymousIdentityAccountSchemaMigration(),
        BuildAdminPrincipalPlaneMigration(),
        BuildAccountRecoveryKeyMigration(),
        BuildAnonymousCommentGovernanceMigration(),
        BuildAnonymousCredentialIssuanceAuditMigration(),
        BuildAnonymousCredentialRootMetadataMigration(),
        BuildAnonymousCredentialRootLifecycleMigration(),
        BuildSecurityRiskEventPersistenceMigration(),
        BuildSecurityPolicySnapshotMigration(),
        BuildSecurityChallengePersistenceMigration(),
        BuildCommentActorPreCodeFirstMigration(),
        BuildCommentActorMigration(),
        BuildCommentAttributionIndexFinalizerMigration(),
        BuildAuditLogMigration(),
        BuildAuditLogStructuredFieldsPreCodeFirstMigration(),
        BuildAuditLogStructuredFieldsMigration(),
        BuildFrontendRumMetricMigration(),
        BuildCoverImageMigration(),
        BuildHumanReadEventMigration(),
        BuildSingleAuthorArticleLifecycleMigration(),
        BuildSingleAuthorArticleLifecycleIndexMigration(),
        BuildArticleMutationOutboxEdgeMigration(),
        BuildAuthoringWorkspaceTablesMigration(),
        BuildAuthoringDraftLifecycleMigration(),
        BuildCommentModerationMigration(),
        BuildCommentModerationIndexMigration(),
        BuildCommentRegionComplianceMigration(),
        BuildCommentModerationSignalMigration(),
        BuildCommentPublicHotPathIndexMigration()
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

    private static ISchemaMigrationDescriptor BuildLegacy20260517ProfileCompatibilityMigration()
        => new SchemaMigrationDescriptor(
            "20260517-pre-legacy-profile-compat",
            "Align the 20260517 legacy PostgreSQL profile before CodeFirst shrink/expand operations.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    DECLARE
                        affected_count bigint;
                        observed_max integer;
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'article' AND column_name = 'title'
                        ) THEN
                            ALTER TABLE article ALTER COLUMN title TYPE varchar(256);
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'article' AND column_name = 'summary'
                        ) THEN
                            ALTER TABLE article ALTER COLUMN summary TYPE varchar(512);
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user' AND column_name = 'username'
                        ) THEN
                            ALTER TABLE sys_user ALTER COLUMN username TYPE varchar(64);
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_visit_log'
                        ) THEN
                            ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS event_type varchar(32);
                            ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS route_key varchar(200) NULL;
                            ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS article_id integer NULL;
                            ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS viewer_key_hash varchar(64) NULL;
                            ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS proof_id varchar(64) NULL;
                            ALTER TABLE sys_visit_log ADD COLUMN IF NOT EXISTS dwell_ms integer;

                            UPDATE sys_visit_log
                            SET event_type = COALESCE(event_type, 'site_read'),
                                dwell_ms = COALESCE(dwell_ms, 0);

                            ALTER TABLE sys_visit_log ALTER COLUMN event_type SET DEFAULT 'site_read';
                            ALTER TABLE sys_visit_log ALTER COLUMN event_type SET NOT NULL;
                            ALTER TABLE sys_visit_log ALTER COLUMN dwell_ms SET DEFAULT 0;
                            ALTER TABLE sys_visit_log ALTER COLUMN dwell_ms SET NOT NULL;
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'category' AND column_name = 'name'
                        ) THEN
                            SELECT COUNT(1), COALESCE(MAX(length(name)), 0)
                            INTO affected_count, observed_max
                            FROM category
                            WHERE name IS NOT NULL AND length(name) > 128;

                            IF affected_count > 0 THEN
                                RAISE EXCEPTION 'Legacy 20260517 length check failed: table=category column=name row_count=% max_length=% expected_max=128',
                                    affected_count,
                                    observed_max;
                            END IF;

                            ALTER TABLE category ALTER COLUMN name TYPE varchar(128);
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'tag' AND column_name = 'name'
                        ) THEN
                            SELECT COUNT(1), COALESCE(MAX(length(name)), 0)
                            INTO affected_count, observed_max
                            FROM tag
                            WHERE name IS NOT NULL AND length(name) > 128;

                            IF affected_count > 0 THEN
                                RAISE EXCEPTION 'Legacy 20260517 length check failed: table=tag column=name row_count=% max_length=% expected_max=128',
                                    affected_count,
                                    observed_max;
                            END IF;

                            ALTER TABLE tag ALTER COLUMN name TYPE varchar(128);
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_systemconfig' AND column_name = 'key'
                        ) THEN
                            IF EXISTS (
                                SELECT 1 FROM information_schema.tables
                                WHERE table_schema = 'public' AND table_name = 'page_content'
                            ) THEN
                                INSERT INTO page_content(slug, content, updated_at)
                                SELECT lower(replace(substr(key, 10), '_', '-')), value, now()
                                FROM sys_systemconfig
                                WHERE key LIKE 'sys:page:%'
                                  AND NOT EXISTS (
                                    SELECT 1 FROM page_content p
                                    WHERE p.slug = lower(replace(substr(sys_systemconfig.key, 10), '_', '-'))
                                  );

                                DELETE FROM sys_systemconfig
                                WHERE key LIKE 'Page_%'
                                   OR key LIKE 'sys:page:%';
                            END IF;

                            SELECT COUNT(1), COALESCE(MAX(length(key)), 0)
                            INTO affected_count, observed_max
                            FROM sys_systemconfig
                            WHERE key IS NOT NULL AND length(key) > 64;

                            IF affected_count > 0 THEN
                                RAISE EXCEPTION 'Legacy 20260517 length check failed: table=sys_systemconfig column=key row_count=% max_length=% expected_max=64',
                                    affected_count,
                                    observed_max;
                            END IF;

                            ALTER TABLE sys_systemconfig ALTER COLUMN key TYPE varchar(64);
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_systemconfig' AND column_name = 'value'
                        ) THEN
                            SELECT COUNT(1), COALESCE(MAX(length(value)), 0)
                            INTO affected_count, observed_max
                            FROM sys_systemconfig
                            WHERE value IS NOT NULL AND length(value) > 512;

                            IF affected_count > 0 THEN
                                RAISE EXCEPTION 'Legacy 20260517 length check failed: table=sys_systemconfig column=value row_count=% max_length=% expected_max=512',
                                    affected_count,
                                    observed_max;
                            END IF;

                            ALTER TABLE sys_systemconfig ALTER COLUMN value TYPE varchar(512);
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

    private static ISchemaMigrationDescriptor BuildUserAuthSecurityHardeningMigration()
        => new SchemaMigrationDescriptor(
            "20260602-post-user-auth-security-hardening",
            "Add MFA pending secret columns and remove legacy plaintext refresh token columns.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "mfapendingsecretencrypted", "text NULL"),
                new EnsureColumnStep("sys_user", "mfapendingcreatedat", "timestamp NULL"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user' AND column_name = 'refreshtoken'
                        ) THEN
                            EXECUTE 'UPDATE sys_user SET refreshtoken = NULL';
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user' AND column_name = 'refresh_token'
                        ) THEN
                            EXECUTE 'UPDATE sys_user SET refresh_token = NULL';
                        END IF;
                    END $$;
                    """),
                new DropColumnStep("sys_user", "refreshtoken"),
                new DropColumnStep("sys_user", "refreshtokenexpirytime"),
                new DropColumnStep("sys_user", "refresh_token"),
                new DropColumnStep("sys_user", "refresh_token_expiry_time")
            ]);

    private static ISchemaMigrationDescriptor BuildAdminPrincipalPlaneMigration()
        => new SchemaMigrationDescriptor(
            "20260616-pre-admin-principal-plane",
            "Create independent admin principal, session, passkey credential and audit-log tables.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "admin_principal",
                    """
                    CREATE TABLE IF NOT EXISTS admin_principal (
                        id bigserial PRIMARY KEY,
                        handle varchar(64) NOT NULL,
                        displayname varchar(96) NULL,
                        status varchar(32) NOT NULL DEFAULT 'active',
                        isroot boolean NOT NULL DEFAULT false,
                        permissions text NOT NULL DEFAULT '',
                        createdatutc timestamp NOT NULL DEFAULT now(),
                        lastloginatutc timestamp NULL,
                        totpenabled boolean NOT NULL DEFAULT false,
                        totpsecretencrypted text NULL,
                        totpverifiedatutc timestamp NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_admin_principal_handle ON admin_principal(handle);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_admin_principal_active_root ON admin_principal(isroot) WHERE isroot = true AND status = 'active';
                    CREATE INDEX IF NOT EXISTS idx_admin_principal_status ON admin_principal(status);
                    """),
                new EnsureTableStep(
                    "admin_session",
                    """
                    CREATE TABLE IF NOT EXISTS admin_session (
                        sessionid varchar(64) PRIMARY KEY,
                        adminprincipalid bigint NOT NULL,
                        accesstokenhash varchar(128) NOT NULL,
                        devicefingerprint varchar(128) NULL,
                        lastip varchar(64) NULL,
                        useragent varchar(512) NULL,
                        createdatutc timestamp NOT NULL DEFAULT now(),
                        lastseenatutc timestamp NULL,
                        idleexpiresatutc timestamp NOT NULL,
                        absoluteexpiresatutc timestamp NOT NULL,
                        revokedatutc timestamp NULL,
                        revokereason varchar(128) NULL,
                        stepupverified boolean NOT NULL DEFAULT false
                    );
                    CREATE INDEX IF NOT EXISTS idx_admin_session_principal ON admin_session(adminprincipalid);
                    CREATE INDEX IF NOT EXISTS idx_admin_session_idle_expires ON admin_session(idleexpiresatutc DESC);
                    """),
                new EnsureTableStep(
                    "admin_passkey_credential",
                    """
                    CREATE TABLE IF NOT EXISTS admin_passkey_credential (
                        id bigserial PRIMARY KEY,
                        adminprincipalid bigint NOT NULL,
                        credentialid varchar(512) NOT NULL,
                        userhandle varchar(128) NOT NULL,
                        publickey text NOT NULL,
                        signcount bigint NOT NULL DEFAULT 0,
                        devicefriendlyname varchar(64) NULL,
                        aaguid varchar(36) NOT NULL DEFAULT '',
                        transports varchar(128) NULL,
                        backupeligible boolean NOT NULL DEFAULT false,
                        backupstate boolean NOT NULL DEFAULT false,
                        createdatutc timestamp NOT NULL DEFAULT now(),
                        lastusedatutc timestamp NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_admin_passkey_cred_id ON admin_passkey_credential(credentialid);
                    CREATE INDEX IF NOT EXISTS idx_admin_passkey_principal ON admin_passkey_credential(adminprincipalid);
                    """),
                new EnsureTableStep(
                    "admin_audit_log",
                    """
                    CREATE TABLE IF NOT EXISTS admin_audit_log (
                        id bigserial PRIMARY KEY,
                        adminprincipalid bigint NULL,
                        adminsessionid varchar(64) NULL,
                        action varchar(96) NOT NULL,
                        outcome varchar(32) NOT NULL,
                        targettype varchar(64) NULL,
                        targetid varchar(128) NULL,
                        iphash varchar(64) NULL,
                        useragenthash varchar(64) NULL,
                        ishighimpact boolean NOT NULL DEFAULT false,
                        metadatajson text NOT NULL DEFAULT '{}',
                        occurredatutc timestamp NOT NULL DEFAULT now()
                    );
                    CREATE INDEX IF NOT EXISTS idx_admin_audit_time ON admin_audit_log(occurredatutc DESC);
                    CREATE INDEX IF NOT EXISTS idx_admin_audit_principal_time ON admin_audit_log(adminprincipalid, occurredatutc DESC);
                    CREATE INDEX IF NOT EXISTS idx_admin_audit_action_time ON admin_audit_log(action, occurredatutc DESC);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildAnonymousIdentityAccountSchemaMigration()
        => new SchemaMigrationDescriptor(
            "20260616-pre-anonymous-identity-account-schema",
            "Reinterpret sys_user as an anonymous account container after destructive identity reset.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_user", "public_handle", "varchar(64) NULL"),
                new EnsureColumnStep("sys_user", "identity_kind", "varchar(32) NOT NULL DEFAULT ''anonymous_account''"),
                new EnsureColumnStep("sys_user", "passkey_enabled", "boolean NOT NULL DEFAULT false"),
                new EnsureColumnStep("sys_user", "recovery_enabled", "boolean NOT NULL DEFAULT false"),
                new EnsureColumnStep("sys_user", "privacy_initialized_at", "timestamp NULL"),
                new EnsureColumnStep("sys_user", "anonymous_credential_level", "varchar(32) NOT NULL DEFAULT ''basic''"),
                new EnsureColumnStep("sys_user", "anonymous_credential_status", "varchar(32) NOT NULL DEFAULT ''active''"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user' AND column_name = 'username'
                        ) THEN
                            ALTER TABLE sys_user ALTER COLUMN username DROP NOT NULL;
                        END IF;

                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public' AND table_name = 'sys_user' AND column_name = 'password'
                        ) THEN
                            ALTER TABLE sys_user ALTER COLUMN password DROP NOT NULL;
                        END IF;
                    END $$;
                    """),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_user'
                        ) THEN
                            UPDATE sys_user
                            SET identity_kind = COALESCE(NULLIF(identity_kind, ''), 'anonymous_account'),
                                passkey_enabled = COALESCE(passkey_enabled, false),
                                recovery_enabled = COALESCE(recovery_enabled, false),
                                anonymous_credential_level = COALESCE(NULLIF(anonymous_credential_level, ''), 'basic'),
                                anonymous_credential_status = COALESCE(NULLIF(anonymous_credential_status, ''), 'active');
                        END IF;
                    END $$;
                    """),
                new CreateIndexStep(
                    "idx_user_public_handle_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_user_public_handle_unique ON sys_user(public_handle) WHERE public_handle IS NOT NULL;")
            ]);

    private static ISchemaMigrationDescriptor BuildAccountRecoveryKeyMigration()
        => new SchemaMigrationDescriptor(
            "20260616-post-account-recovery-key",
            "Create independent account recovery key storage for anonymous identity recovery.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "account_recovery_key",
                    """
                    CREATE TABLE IF NOT EXISTS account_recovery_key (
                        id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        user_id integer NOT NULL,
                        lookup_id_hash text NULL,
                        key_hash text NOT NULL,
                        key_version integer NOT NULL,
                        created_at timestamp NOT NULL DEFAULT now(),
                        used_at timestamp NULL,
                        revoked_at timestamp NULL
                    );
                    """),
                new EnsureColumnStep("account_recovery_key", "user_id", "integer NOT NULL"),
                new EnsureColumnStep("account_recovery_key", "lookup_id_hash", "text NULL"),
                new EnsureColumnStep("account_recovery_key", "key_hash", "text NOT NULL"),
                new EnsureColumnStep("account_recovery_key", "key_version", "integer NOT NULL"),
                new EnsureColumnStep("account_recovery_key", "created_at", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("account_recovery_key", "used_at", "timestamp NULL"),
                new EnsureColumnStep("account_recovery_key", "revoked_at", "timestamp NULL"),
                new CreateIndexStep(
                    "idx_account_recovery_key_user",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_user ON account_recovery_key(user_id);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_version",
                    "CREATE INDEX IF NOT EXISTS idx_account_recovery_key_version ON account_recovery_key(user_id, key_version DESC);"),
                new CreateIndexStep(
                    "idx_account_recovery_key_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_active_unique ON account_recovery_key(user_id) WHERE used_at IS NULL AND revoked_at IS NULL;"),
                new CreateIndexStep(
                    "idx_account_recovery_key_lookup_active_unique",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_account_recovery_key_lookup_active_unique ON account_recovery_key(lookup_id_hash) WHERE lookup_id_hash IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL;")
            ]);

    private static ISchemaMigrationDescriptor BuildAnonymousCommentGovernanceMigration()
        => new SchemaMigrationDescriptor(
            "20260616-post-anonymous-comment-governance",
            "Create anonymous comment policy, credential, and nullifier governance tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_comment_policy",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_comment_policy (
                        id integer PRIMARY KEY,
                        anonymous_comments_enabled boolean NOT NULL DEFAULT true,
                        public_comments_enabled boolean NOT NULL DEFAULT true,
                        zk_anonymous_enabled boolean NOT NULL DEFAULT false,
                        default_author_mode varchar(32) NOT NULL DEFAULT 'anonymous',
                        supported_display_languages varchar(128) NOT NULL DEFAULT 'zh-CN,en',
                        snapshot_hash varchar(64) NOT NULL DEFAULT '',
                        updated_reason varchar(256) NULL,
                        changed_by varchar(64) NOT NULL DEFAULT 'system',
                        updated_at_utc timestamp NOT NULL DEFAULT now(),
                        updated_by_admin_id bigint NULL
                    );
                    INSERT INTO anonymous_comment_policy (
                        id,
                        anonymous_comments_enabled,
                        public_comments_enabled,
                        zk_anonymous_enabled,
                        default_author_mode,
                        supported_display_languages,
                        snapshot_hash,
                        changed_by,
                        updated_at_utc
                    )
                    VALUES (1, true, true, false, 'anonymous', 'zh-CN,en', '', 'system', now())
                    ON CONFLICT (id) DO NOTHING;
                    """),
                new EnsureColumnStep("anonymous_comment_policy", "snapshot_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("anonymous_comment_policy", "updated_reason", "varchar(256) NULL"),
                new EnsureColumnStep("anonymous_comment_policy", "changed_by", "varchar(64) NOT NULL DEFAULT 'system'"),
                new EnsureTableStep(
                    "anonymous_credential",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential (
                        id bigserial PRIMARY KEY,
                        user_id integer NULL,
                        commitment_hash varchar(128) NOT NULL,
                        credential_type varchar(32) NOT NULL DEFAULT 'account_bound',
                        credential_level varchar(32) NOT NULL DEFAULT 'basic',
                        status varchar(32) NOT NULL DEFAULT 'active',
                        issued_at_utc timestamp NOT NULL DEFAULT now(),
                        revoked_at_utc timestamp NULL,
                        metadata_json text NOT NULL DEFAULT '{}'
                    );
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_user ON anonymous_credential(user_id);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_commitment ON anonymous_credential(commitment_hash);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_status ON anonymous_credential(status);
                    """),
                new EnsureTableStep(
                    "comment_anonymous_nullifier",
                    """
                    CREATE TABLE IF NOT EXISTS comment_anonymous_nullifier (
                        id bigserial PRIMARY KEY,
                        nullifier_hash varchar(128) NOT NULL,
                        scope varchar(128) NOT NULL,
                        use_count integer NOT NULL DEFAULT 0,
                        first_comment_id bigint NULL,
                        last_comment_id bigint NULL,
                        blocked boolean NOT NULL DEFAULT false,
                        block_reason varchar(256) NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        updated_at_utc timestamp NOT NULL DEFAULT now()
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_comment_nullifier_scope ON comment_anonymous_nullifier(nullifier_hash, scope);
                    CREATE INDEX IF NOT EXISTS idx_comment_nullifier_blocked ON comment_anonymous_nullifier(blocked);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildAnonymousCredentialIssuanceAuditMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-anonymous-credential-issuance-audit",
            "Create unlinkable anonymous credential issuance audit table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_credential_issuance_audit",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_issuance_audit (
                        id bigserial PRIMARY KEY,
                        user_id integer NOT NULL,
                        epoch bigint NOT NULL,
                        status varchar(32) NOT NULL DEFAULT 'issued',
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        trace_id varchar(64) NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_issuance_user ON anonymous_credential_issuance_audit(user_id);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_issuance_user_epoch ON anonymous_credential_issuance_audit(user_id, epoch);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_issuance_epoch ON anonymous_credential_issuance_audit(epoch);
                    """),
                new DropColumnStep("anonymous_credential_issuance_audit", "request_hash")
            ]);

    private static ISchemaMigrationDescriptor BuildSecurityRiskEventPersistenceMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-security-risk-event-persistence",
            "Create durable RiskControl event audit table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_risk_event",
                    """
                    CREATE TABLE IF NOT EXISTS security_risk_event (
                        id varchar(64) PRIMARY KEY,
                        occurred_at_utc timestamp NOT NULL,
                        source varchar(64) NOT NULL,
                        reason varchar(64) NOT NULL,
                        action varchar(96) NOT NULL,
                        score_delta integer NOT NULL,
                        total_score integer NOT NULL,
                        ttl_seconds integer NOT NULL,
                        expires_at_utc timestamp NOT NULL,
                        subject_hash varchar(64) NULL,
                        route_key varchar(160) NULL,
                        client_ip_hash varchar(64) NULL,
                        device_fp_hash varchar(64) NULL,
                        path varchar(256) NULL,
                        method varchar(16) NULL,
                        user_agent varchar(256) NULL,
                        detail varchar(256) NULL,
                        trace_id varchar(64) NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_source_reason_action ON security_risk_event(source, reason, action);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_subject ON security_risk_event(subject_hash);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_client_ip ON security_risk_event(client_ip_hash);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_device ON security_risk_event(device_fp_hash);
                    CREATE INDEX IF NOT EXISTS idx_security_risk_event_expires ON security_risk_event(expires_at_utc);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildSecurityPolicySnapshotMigration()
        => new SchemaMigrationDescriptor(
            "20260619-post-security-policy-snapshot",
            "Create versioned RiskControl security policy snapshot storage.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_policy_snapshot",
                    """
                    CREATE TABLE IF NOT EXISTS security_policy_snapshot (
                        id bigserial PRIMARY KEY,
                        policy_id varchar(64) NOT NULL,
                        version bigint NOT NULL,
                        mode varchar(32) NOT NULL,
                        document text NOT NULL,
                        created_by_admin_id bigint NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        activated_at_utc timestamp NULL,
                        revoked_at_utc timestamp NULL,
                        is_last_known_good boolean NOT NULL DEFAULT false,
                        rollback_of_version bigint NULL,
                        reason varchar(128) NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_policy_snapshot_policy_version
                        ON security_policy_snapshot(policy_id, version);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_policy_snapshot_active
                        ON security_policy_snapshot(policy_id)
                        WHERE activated_at_utc IS NOT NULL AND revoked_at_utc IS NULL;
                    CREATE INDEX IF NOT EXISTS idx_security_policy_snapshot_lkg
                        ON security_policy_snapshot(policy_id, is_last_known_good, version DESC);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildAnonymousCredentialRootMetadataMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-anonymous-credential-root-metadata",
            "Create public anonymous credential root and circuit metadata table.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_credential_root",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_root (
                        epoch bigint PRIMARY KEY,
                        root_hash varchar(128) NOT NULL,
                        revocation_root_hash varchar(128) NOT NULL DEFAULT '',
                        circuit_id varchar(96) NOT NULL,
                        circuit_numeric_id integer NOT NULL DEFAULT 0,
                        verifying_key_hash varchar(128) NOT NULL,
                        issuer_public_key_hash varchar(128) NOT NULL DEFAULT '',
                        public_input_layout_version integer NOT NULL,
                        circuit_metadata text NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        expires_at_utc timestamp NOT NULL,
                        root_grace_expires_at_utc timestamp NOT NULL,
                        status varchar(32) NOT NULL DEFAULT 'active'
                    );
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_status_expires ON anonymous_credential_root(status, root_grace_expires_at_utc);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_circuit ON anonymous_credential_root(circuit_id);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildAnonymousCredentialRootLifecycleMigration()
        => new SchemaMigrationDescriptor(
            "20260619-post-anonymous-credential-root-lifecycle",
            "Create anonymous credential root lifecycle epoch and revocation storage.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "anonymous_credential_epoch",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_epoch (
                        epoch bigint PRIMARY KEY,
                        status varchar(32) NOT NULL DEFAULT 'draft',
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        activated_at_utc timestamp NULL,
                        expires_at_utc timestamp NOT NULL,
                        root_grace_expires_at_utc timestamp NOT NULL,
                        active_root_hash varchar(128) NULL,
                        reason varchar(128) NULL
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_epoch_epoch ON anonymous_credential_epoch(epoch);
                    """),
                new EnsureColumnStep("anonymous_credential_root", "activated_at_utc", "timestamp NULL"),
                new EnsureColumnStep("anonymous_credential_root", "issuer_public_key_hash", "varchar(128) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("anonymous_credential_root", "revoked_at_utc", "timestamp NULL"),
                new EnsureColumnStep("anonymous_credential_root", "updated_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("anonymous_credential_root", "revoke_reason", "varchar(128) NULL"),
                new RawSqlStep("""
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_hash ON anonymous_credential_root(root_hash);
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_root_single_active ON anonymous_credential_root(status) WHERE status = 'active';
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_root_status_epoch ON anonymous_credential_root(status, epoch);
                    """),
                new EnsureTableStep(
                    "anonymous_credential_revocation",
                    """
                    CREATE TABLE IF NOT EXISTS anonymous_credential_revocation (
                        id bigserial PRIMARY KEY,
                        epoch bigint NOT NULL,
                        root_hash varchar(128) NOT NULL,
                        revocation_handle_hash varchar(128) NOT NULL,
                        revocation_root_hash varchar(128) NOT NULL,
                        reason varchar(128) NULL,
                        actor_id varchar(128) NULL,
                        revoked_at_utc timestamp NOT NULL DEFAULT now()
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_anonymous_credential_revocation_epoch_handle
                        ON anonymous_credential_revocation(epoch, revocation_handle_hash);
                    CREATE INDEX IF NOT EXISTS idx_anonymous_credential_revocation_epoch ON anonymous_credential_revocation(epoch);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildSecurityChallengePersistenceMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-security-challenge-persistence",
            "Create auditable security challenge issuance and verification attempt storage.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "security_challenge",
                    """
                    CREATE TABLE IF NOT EXISTS security_challenge (
                        id bigserial PRIMARY KEY,
                        challenge_id varchar(64) NOT NULL,
                        status varchar(32) NOT NULL DEFAULT 'issued',
                        kind varchar(64) NOT NULL DEFAULT '',
                        algorithm varchar(64) NOT NULL DEFAULT '',
                        action varchar(96) NOT NULL DEFAULT '',
                        route_key varchar(256) NOT NULL DEFAULT '',
                        subject_hash varchar(64) NOT NULL DEFAULT '',
                        client_ip_hash varchar(64) NOT NULL DEFAULT '',
                        device_fp_hash varchar(64) NOT NULL DEFAULT '',
                        policy_version varchar(64) NOT NULL DEFAULT '',
                        payload_hash varchar(64) NOT NULL DEFAULT '',
                        trace_id varchar(64) NULL,
                        traceparent varchar(128) NULL,
                        issued_at_utc timestamp NOT NULL DEFAULT now(),
                        expires_at_utc timestamp NOT NULL DEFAULT now(),
                        verified_at_utc timestamp NULL,
                        revoked_at_utc timestamp NULL,
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        updated_at_utc timestamp NOT NULL DEFAULT now(),
                        CONSTRAINT chk_security_challenge_status
                            CHECK (status IN ('issued', 'verified', 'expired', 'replayed', 'failed', 'revoked'))
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_id ON security_challenge(challenge_id);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_status_expiry ON security_challenge(status, expires_at_utc);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_action_route ON security_challenge(action, route_key);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_subject ON security_challenge(subject_hash);
                    """),
                new EnsureColumnStep("security_challenge", "challenge_id", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "status", "varchar(32) NOT NULL DEFAULT 'issued'"),
                new EnsureColumnStep("security_challenge", "kind", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "algorithm", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "action", "varchar(96) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "route_key", "varchar(256) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "subject_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "client_ip_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "device_fp_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "policy_version", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "payload_hash", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge", "trace_id", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge", "traceparent", "varchar(128) NULL"),
                new EnsureColumnStep("security_challenge", "issued_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge", "expires_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge", "verified_at_utc", "timestamp NULL"),
                new EnsureColumnStep("security_challenge", "revoked_at_utc", "timestamp NULL"),
                new EnsureColumnStep("security_challenge", "created_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge", "updated_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureTableStep(
                    "security_challenge_attempt",
                    """
                    CREATE TABLE IF NOT EXISTS security_challenge_attempt (
                        id bigserial PRIMARY KEY,
                        attempt_id varchar(64) NOT NULL,
                        challenge_id varchar(64) NOT NULL,
                        outcome varchar(32) NOT NULL,
                        reason varchar(128) NULL,
                        payload_hash varchar(64) NULL,
                        client_ip_hash varchar(64) NULL,
                        device_fp_hash varchar(64) NULL,
                        trace_id varchar(64) NULL,
                        traceparent varchar(128) NULL,
                        attempted_at_utc timestamp NOT NULL DEFAULT now(),
                        created_at_utc timestamp NOT NULL DEFAULT now(),
                        CONSTRAINT chk_security_challenge_attempt_outcome
                            CHECK (outcome IN ('verified', 'expired', 'replayed', 'failed', 'revoked'))
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_attempt_id ON security_challenge_attempt(attempt_id);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_challenge ON security_challenge_attempt(challenge_id, attempted_at_utc DESC);
                    CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_outcome ON security_challenge_attempt(outcome, attempted_at_utc DESC);
                    """),
                new EnsureColumnStep("security_challenge_attempt", "attempt_id", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge_attempt", "challenge_id", "varchar(64) NOT NULL DEFAULT ''"),
                new EnsureColumnStep("security_challenge_attempt", "outcome", "varchar(32) NOT NULL DEFAULT 'failed'"),
                new EnsureColumnStep("security_challenge_attempt", "reason", "varchar(128) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "payload_hash", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "client_ip_hash", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "device_fp_hash", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "trace_id", "varchar(64) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "traceparent", "varchar(128) NULL"),
                new EnsureColumnStep("security_challenge_attempt", "attempted_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new EnsureColumnStep("security_challenge_attempt", "created_at_utc", "timestamp NOT NULL DEFAULT now()"),
                new CreateIndexStep(
                    "unique_idx_security_challenge_id",
                    "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_id ON security_challenge(challenge_id);"),
                new CreateIndexStep(
                    "idx_security_challenge_status_expiry",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_status_expiry ON security_challenge(status, expires_at_utc);"),
                new CreateIndexStep(
                    "idx_security_challenge_action_route",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_action_route ON security_challenge(action, route_key);"),
                new CreateIndexStep(
                    "idx_security_challenge_subject",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_subject ON security_challenge(subject_hash);"),
                new CreateIndexStep(
                    "unique_idx_security_challenge_attempt_id",
                    "CREATE UNIQUE INDEX IF NOT EXISTS unique_idx_security_challenge_attempt_id ON security_challenge_attempt(attempt_id);"),
                new CreateIndexStep(
                    "idx_security_challenge_attempt_challenge",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_challenge ON security_challenge_attempt(challenge_id, attempted_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_security_challenge_attempt_outcome",
                    "CREATE INDEX IF NOT EXISTS idx_security_challenge_attempt_outcome ON security_challenge_attempt(outcome, attempted_at_utc DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentActorMigration()
        => new SchemaMigrationDescriptor(
            "20260617-post-comment-actor-anonymous-default",
            "Allow anonymous comment actors and persist author display projections on comments.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'comment'
                              AND column_name = 'user_id'
                              AND is_nullable = 'NO'
                        ) THEN
                            ALTER TABLE comment ALTER COLUMN user_id DROP NOT NULL;
                        END IF;
                    END $$;
                    """),
                new EnsureColumnStep("comment", "author_mode", "varchar(32) NOT NULL DEFAULT 'anonymous'"),
                new EnsureColumnStep("comment", "public_handle", "varchar(64) NULL"),
                new EnsureColumnStep("comment", "anonymous_handle", "varchar(64) NULL"),
                new EnsureColumnStep("comment", "anonymous_display_name", "varchar(96) NULL"),
                new EnsureColumnStep("comment", "anonymous_display_language", "varchar(16) NULL"),
                new EnsureColumnStep("comment", "anonymous_nullifier_hash", "varchar(128) NULL"),
                new EnsureColumnStep("comment", "anonymous_scope", "varchar(128) NULL"),
                new EnsureColumnStep("comment", "moderation_subject_hash", "varchar(128) NULL"),
                new EnsureColumnStep("comment", "credential_level", "varchar(32) NULL"),
                new EnsureColumnStep("comment", "reputation_bucket", "varchar(32) NULL"),
                new EnsureColumnStep("comment", "account_age_bucket", "varchar(32) NULL"),
                new CreateIndexStep(
                    "idx_comment_author_mode",
                    "CREATE INDEX IF NOT EXISTS idx_comment_author_mode ON comment(author_mode);"),
                new CreateIndexStep(
                    "idx_comment_anonymous_scope",
                    "CREATE INDEX IF NOT EXISTS idx_comment_anonymous_scope ON comment(anonymous_scope);"),
                new CreateIndexStep(
                    "idx_comment_moderation_subject_hash",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_subject_hash ON comment(moderation_subject_hash);")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentActorPreCodeFirstMigration()
        => new SchemaMigrationDescriptor(
            "20260620-pre-comment-actor-codefirst-compat",
            "Backfill comment actor columns before CodeFirst touches legacy comment tables.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'comment'
                              AND column_name = 'user_id'
                              AND is_nullable = 'NO'
                        ) THEN
                            ALTER TABLE comment ALTER COLUMN user_id DROP NOT NULL;
                        END IF;
                    END $$;
                    """),
                new EnsureColumnStep("comment", "author_mode", "varchar(32) NOT NULL DEFAULT 'public'")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentAttributionIndexFinalizerMigration()
        => new SchemaMigrationDescriptor(
            "20260621-post-comment-attribution-index-finalize",
            "Retire generic comment user_id index and keep only explicit public attribution lookup.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new DropIndexStep("idx_comment_user_id_desc"),
                new CreateIndexStep(
                    "idx_comment_attributable_public_user_id_desc",
                    "CREATE INDEX IF NOT EXISTS idx_comment_attributable_public_user_id_desc ON comment(user_id, id DESC) WHERE author_mode = 'public' AND user_id IS NOT NULL;")
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
                        context_payload bytea NULL
                    );
                    """),
                new EnsureColumnStep("sys_audit_log", "context_payload", "bytea"),
                new DropColumnStep("sys_audit_log", "context_json"),
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

    private static ISchemaMigrationDescriptor BuildAuditLogStructuredFieldsMigration()
        => new SchemaMigrationDescriptor(
            "20260603-post-audit-structured-fields",
            "Add structured audit fields, privacy hashes, and tamper-evidence metadata.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_audit_log", "actor_type", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_id", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_role", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "action", "varchar(96) NOT NULL DEFAULT ''log.recorded''"),
                new EnsureColumnStep("sys_audit_log", "target_type", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "target_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "outcome", "varchar(32) NOT NULL DEFAULT ''unknown''"),
                new EnsureColumnStep("sys_audit_log", "severity", "varchar(32) NOT NULL DEFAULT ''info''"),
                new EnsureColumnStep("sys_audit_log", "is_high_value", "boolean NOT NULL DEFAULT false"),
                new EnsureColumnStep("sys_audit_log", "trace_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_path", "varchar(256) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_method", "varchar(16) NULL"),
                new EnsureColumnStep("sys_audit_log", "ip_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "user_agent_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "session_id_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "device_fingerprint_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "reason_code", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "context_json", "text NULL"),
                new EnsureColumnStep("sys_audit_log", "chain_id", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "prev_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_mac", "varchar(64) NULL"),
                new CreateIndexStep(
                    "idx_audit_action_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_action_time ON sys_audit_log(action, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_actor_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_actor_time ON sys_audit_log(actor_id, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_target_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_target_time ON sys_audit_log(target_type, target_id, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_outcome_time",
                    "CREATE INDEX IF NOT EXISTS idx_audit_outcome_time ON sys_audit_log(outcome, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_audit_record_hash",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_record_hash ON sys_audit_log(record_hash) WHERE record_hash IS NOT NULL;")
            ]);

    private static ISchemaMigrationDescriptor BuildAuditLogStructuredFieldsPreCodeFirstMigration()
        => new SchemaMigrationDescriptor(
            "20260603-pre-audit-structured-fields-codefirst-compat",
            "Create structured audit fields before CodeFirst sync touches non-null audit columns.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_audit_log", "actor_type", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_id", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "actor_role", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "action", "varchar(96) NULL DEFAULT ''log.recorded''"),
                new EnsureColumnStep("sys_audit_log", "target_type", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "target_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "outcome", "varchar(32) NULL DEFAULT ''unknown''"),
                new EnsureColumnStep("sys_audit_log", "severity", "varchar(32) NULL DEFAULT ''info''"),
                new EnsureColumnStep("sys_audit_log", "is_high_value", "boolean NULL DEFAULT false"),
                new EnsureColumnStep("sys_audit_log", "trace_id", "varchar(128) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_path", "varchar(256) NULL"),
                new EnsureColumnStep("sys_audit_log", "request_method", "varchar(16) NULL"),
                new EnsureColumnStep("sys_audit_log", "ip_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "user_agent_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "session_id_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "device_fingerprint_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "reason_code", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "context_json", "text NULL"),
                new EnsureColumnStep("sys_audit_log", "chain_id", "varchar(32) NULL"),
                new EnsureColumnStep("sys_audit_log", "prev_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_hash", "varchar(64) NULL"),
                new EnsureColumnStep("sys_audit_log", "record_mac", "varchar(64) NULL"),
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'sys_audit_log'
                        ) THEN
                            UPDATE sys_audit_log
                            SET action = COALESCE(action, 'log.recorded'),
                                outcome = COALESCE(outcome, 'unknown'),
                                severity = COALESCE(severity, 'info'),
                                is_high_value = COALESCE(is_high_value, false);

                            ALTER TABLE sys_audit_log ALTER COLUMN action SET NOT NULL;
                            ALTER TABLE sys_audit_log ALTER COLUMN outcome SET NOT NULL;
                            ALTER TABLE sys_audit_log ALTER COLUMN severity SET NOT NULL;
                            ALTER TABLE sys_audit_log ALTER COLUMN is_high_value SET NOT NULL;
                        END IF;
                    END $$;
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildFrontendRumMetricMigration()
        => new SchemaMigrationDescriptor(
            "20260603-post-frontend-rum-metric",
            "Move browser RUM telemetry out of the security audit log.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "frontend_rum_metric",
                    """
                    CREATE TABLE IF NOT EXISTS frontend_rum_metric (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        name varchar(64) NOT NULL,
                        page_type varchar(32) NOT NULL,
                        aot_source varchar(32) NOT NULL,
                        value double precision NULL,
                        metrics_json text NOT NULL DEFAULT '{}',
                        occurred_at_utc timestamp NOT NULL,
                        created_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "idx_rum_occurred_at_desc",
                    "CREATE INDEX IF NOT EXISTS idx_rum_occurred_at_desc ON frontend_rum_metric(occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_rum_name_time",
                    "CREATE INDEX IF NOT EXISTS idx_rum_name_time ON frontend_rum_metric(name, occurred_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_rum_page_type_time",
                    "CREATE INDEX IF NOT EXISTS idx_rum_page_type_time ON frontend_rum_metric(page_type, occurred_at_utc DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildCoverImageMigration()
        => new SchemaMigrationDescriptor(
            "20260508-pre-cover-image",
            "Add coverimageurl to article table.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article", "coverimageurl", "VARCHAR(512)")
            ]);

    private static ISchemaMigrationDescriptor BuildHumanReadEventMigration()
        => new SchemaMigrationDescriptor(
            "20260513-post-human-read-events",
            "Extend visit logs into the single human-read event source and seed legacy article views.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("sys_visit_log", "event_type", "VARCHAR(32)"),
                new EnsureColumnStep("sys_visit_log", "route_key", "VARCHAR(200) NULL"),
                new EnsureColumnStep("sys_visit_log", "article_id", "INTEGER NULL"),
                new EnsureColumnStep("sys_visit_log", "viewer_key_hash", "VARCHAR(64) NULL"),
                new EnsureColumnStep("sys_visit_log", "proof_id", "VARCHAR(64) NULL"),
                new EnsureColumnStep("sys_visit_log", "dwell_ms", "INTEGER NOT NULL DEFAULT 0"),
                new BackfillSqlStep("UPDATE sys_visit_log SET event_type = 'site_read' WHERE event_type IS NULL;"),
                new EnsureTableStep(
                    "article_view_seed",
                    """
                    CREATE TABLE IF NOT EXISTS article_view_seed (
                        article_id integer PRIMARY KEY,
                        legacy_views integer NOT NULL DEFAULT 0,
                        seeded_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new BackfillSqlStep(
                    """
                    INSERT INTO article_view_seed(article_id, legacy_views, seeded_at_utc)
                    SELECT id, COALESCE(views, 0), now() AT TIME ZONE 'utc'
                    FROM article
                    ON CONFLICT (article_id) DO NOTHING;
                    """),
                new CreateIndexStep(
                    "idx_visit_event_time",
                    "CREATE INDEX IF NOT EXISTS idx_visit_event_time ON sys_visit_log(event_type, createtime DESC);"),
                new CreateIndexStep(
                    "idx_visit_article_time",
                    "CREATE INDEX IF NOT EXISTS idx_visit_article_time ON sys_visit_log(article_id, createtime DESC);"),
                new CreateIndexStep(
                    "idx_visit_proof_id",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_visit_proof_id ON sys_visit_log(proof_id) WHERE proof_id IS NOT NULL;")
            ]);

    private static ISchemaMigrationDescriptor BuildSingleAuthorArticleLifecycleMigration()
        => new SchemaMigrationDescriptor(
            "20260518-pre-single-author-article-lifecycle",
            "Add article lifecycle state for draft, scheduled, published, archived, and deleted flows.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article", "status", "integer NOT NULL DEFAULT 2"),
                new EnsureColumnStep("article", "scheduled_publish_at", "timestamp NULL"),
                new EnsureColumnStep("article", "published_at", "timestamp NULL"),
                new EnsureColumnStep("article", "archived_at", "timestamp NULL"),
                new EnsureColumnStep("article", "deleted_at", "timestamp NULL"),
                new BackfillSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1 FROM information_schema.tables
                            WHERE table_schema = 'public' AND table_name = 'article'
                        ) THEN
                            UPDATE article
                            SET status = CASE WHEN isdeleted THEN 4 ELSE 2 END,
                                published_at = COALESCE(published_at, createtime),
                                deleted_at = CASE WHEN isdeleted AND deleted_at IS NULL THEN now() ELSE deleted_at END
                            WHERE status IS NULL
                               OR published_at IS NULL
                               OR (isdeleted AND deleted_at IS NULL);
                        END IF;
                    END $$;
                    """),
                new CreateIndexStep(
                    "idx_article_public_state_time",
                    "CREATE INDEX IF NOT EXISTS idx_article_public_state_time ON article(status, isdeleted, published_at DESC, createtime DESC);"),
                new CreateIndexStep(
                    "idx_article_scheduled_publish",
                    "CREATE INDEX IF NOT EXISTS idx_article_scheduled_publish ON article(status, scheduled_publish_at) WHERE status = 1;")
            ]);

    private static ISchemaMigrationDescriptor BuildSingleAuthorArticleLifecycleIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-single-author-article-lifecycle-indexes",
            "Ensure article lifecycle indexes exist after CodeFirst creates fresh article tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_article_public_state_time",
                    "CREATE INDEX IF NOT EXISTS idx_article_public_state_time ON article(status, isdeleted, published_at DESC, createtime DESC);"),
                new CreateIndexStep(
                    "idx_article_scheduled_publish",
                    "CREATE INDEX IF NOT EXISTS idx_article_scheduled_publish ON article(status, scheduled_publish_at) WHERE status = 1;")
            ]);

    private static ISchemaMigrationDescriptor BuildArticleMutationOutboxEdgeMigration()
        => new SchemaMigrationDescriptor(
            "20260618-post-article-mutation-outbox-edge",
            "Create edge-level replay state for article mutation outbox events.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_mutation_outbox_edge",
                    """
                    CREATE TABLE IF NOT EXISTS article_mutation_outbox_edge (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        outbox_event_id bigint NOT NULL,
                        edge_name varchar(64) NOT NULL,
                        status varchar(24) NOT NULL DEFAULT 'pending',
                        attempt_count integer NOT NULL DEFAULT 0,
                        last_error varchar(1024) NULL,
                        updated_at timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "ux_article_mutation_outbox_edge_event_name",
                    """
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_mutation_outbox_edge_event_name
                    ON article_mutation_outbox_edge(outbox_event_id, edge_name);
                    """),
                new CreateIndexStep(
                    "idx_article_mutation_outbox_edge_status",
                    """
                    CREATE INDEX IF NOT EXISTS idx_article_mutation_outbox_edge_status
                    ON article_mutation_outbox_edge(status, updated_at DESC);
                    """)
            ]);

    private static ISchemaMigrationDescriptor BuildAuthoringWorkspaceTablesMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-authoring-workspace-tables",
            "Create durable authoring tables for server drafts, revisions, assets, and site subscriptions.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_draft",
                    """
                    CREATE TABLE IF NOT EXISTS article_draft (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        owner_user_id integer NOT NULL,
                        article_id integer NULL,
                        draft_key varchar(96) NOT NULL,
                        title varchar(256) NOT NULL DEFAULT '',
                        summary varchar(512) NULL,
                        cover_image_url varchar(512) NULL,
                        categoryid integer NOT NULL DEFAULT 0,
                        tag_ids text NOT NULL DEFAULT '',
                        markdown_content text NOT NULL DEFAULT '',
                        client_revision varchar(64) NULL,
                        updated_at timestamp NOT NULL DEFAULT now(),
                        created_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "idx_article_draft_owner_key",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_article_draft_owner_key ON article_draft(owner_user_id, draft_key);"),
                new EnsureTableStep(
                    "article_revision",
                    """
                    CREATE TABLE IF NOT EXISTS article_revision (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        article_id integer NOT NULL,
                        revision_no integer NOT NULL,
                        title varchar(256) NOT NULL DEFAULT '',
                        summary varchar(512) NULL,
                        cover_image_url varchar(512) NULL,
                        categoryid integer NOT NULL DEFAULT 0,
                        tag_ids text NOT NULL DEFAULT '',
                        markdown_content text NOT NULL DEFAULT '',
                        diff_summary varchar(512) NOT NULL DEFAULT '',
                        created_by_user_id integer NOT NULL DEFAULT 0,
                        created_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "idx_article_revision_article_time",
                    "CREATE INDEX IF NOT EXISTS idx_article_revision_article_time ON article_revision(article_id, created_at DESC);"),
                new EnsureTableStep(
                    "asset_library_item",
                    """
                    CREATE TABLE IF NOT EXISTS asset_library_item (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        url varchar(512) NOT NULL,
                        alt_text varchar(256) NULL,
                        source_article_id integer NULL,
                        width integer NULL,
                        height integer NULL,
                        sha256 varchar(64) NULL,
                        reference_count integer NOT NULL DEFAULT 0,
                        created_at timestamp NOT NULL DEFAULT now(),
                        updated_at timestamp NOT NULL DEFAULT now()
                    );
                    """),
                new CreateIndexStep(
                    "idx_asset_library_hash",
                    "CREATE INDEX IF NOT EXISTS idx_asset_library_hash ON asset_library_item(sha256);"),
                new EnsureTableStep(
                    "site_subscription",
                    """
                    CREATE TABLE IF NOT EXISTS site_subscription (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        email_hash varchar(64) NOT NULL,
                        channel varchar(32) NOT NULL DEFAULT 'rss',
                        is_enabled boolean NOT NULL DEFAULT true,
                        created_at timestamp NOT NULL DEFAULT now(),
                        unsubscribed_at timestamp NULL
                    );
                    """),
                new CreateIndexStep(
                    "idx_site_subscription_email",
                    "CREATE UNIQUE INDEX IF NOT EXISTS idx_site_subscription_email ON site_subscription(email_hash);")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentModerationMigration()
        => new SchemaMigrationDescriptor(
            "20260518-pre-comment-moderation",
            "Add comment moderation state, reason, actor, and timestamp.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment", "moderation_status", "integer NOT NULL DEFAULT 1"),
                new EnsureColumnStep("comment", "moderation_reason", "varchar(256) NULL"),
                new EnsureColumnStep("comment", "moderated_by_user_id", "integer NULL"),
                new EnsureColumnStep("comment", "moderated_at", "timestamp NULL"),
                new CreateIndexStep(
                    "idx_comment_moderation_status_time",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_status_time ON comment(moderation_status, create_time DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildAuthoringDraftLifecycleMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-authoring-draft-lifecycle",
            "Persist article lifecycle fields in durable authoring drafts.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("article_draft", "status", "integer NOT NULL DEFAULT 2"),
                new EnsureColumnStep("article_draft", "scheduled_publish_at", "timestamp NULL")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentModerationIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260518-post-comment-moderation-indexes",
            "Ensure comment moderation indexes exist after CodeFirst creates fresh comment tables.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_comment_moderation_status_time",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_status_time ON comment(moderation_status, create_time DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentRegionComplianceMigration()
        => new SchemaMigrationDescriptor(
            "20260610-post-comment-region-compliance",
            "Create region-aware comment compliance storage and lookup indexes.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "comment_region_compliance",
                    """
                    CREATE TABLE IF NOT EXISTS comment_region_compliance (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        comment_id bigint NOT NULL,
                        submit_region varchar(64) NOT NULL,
                        submit_region_confidence double precision NOT NULL DEFAULT 0,
                        region_provider varchar(64) NOT NULL DEFAULT 'unknown',
                        submit_ip_hash varchar(64) NULL,
                        policy_version varchar(64) NOT NULL,
                        can_publish boolean NOT NULL,
                        requires_manual_review boolean NOT NULL DEFAULT false,
                        hide_until_reviewed boolean NOT NULL DEFAULT false,
                        blocked_regions text NOT NULL DEFAULT '',
                        risk_labels text NOT NULL DEFAULT '',
                        decision_reason varchar(256) NULL,
                        rule_hits_json text NULL,
                        created_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                        updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "idx_comment_region_compliance_comment",
                    "CREATE INDEX IF NOT EXISTS idx_comment_region_compliance_comment ON comment_region_compliance(comment_id);"),
                new CreateIndexStep(
                    "idx_comment_region_compliance_submit_region",
                    "CREATE INDEX IF NOT EXISTS idx_comment_region_compliance_submit_region ON comment_region_compliance(submit_region, created_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_comment_region_compliance_policy",
                    "CREATE INDEX IF NOT EXISTS idx_comment_region_compliance_policy ON comment_region_compliance(policy_version, created_at_utc DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentModerationSignalMigration()
        => new SchemaMigrationDescriptor(
            "20260610-post-comment-moderation-signal",
            "Create optional anti-spam model signal storage for comment moderation.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "comment_moderation_signal",
                    """
                    CREATE TABLE IF NOT EXISTS comment_moderation_signal (
                        id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                        comment_id bigint NOT NULL,
                        provider varchar(64) NOT NULL,
                        model varchar(128) NOT NULL,
                        contract_version varchar(64) NOT NULL,
                        label varchar(64) NOT NULL,
                        severity varchar(32) NOT NULL,
                        confidence double precision NOT NULL DEFAULT 0,
                        primary_reason varchar(128) NULL,
                        needs_second_round boolean NOT NULL DEFAULT false,
                        risk_categories text NULL,
                        evidence_json text NULL,
                        raw_reason text NULL,
                        latency_ms integer NOT NULL DEFAULT 0,
                        status varchar(32) NOT NULL DEFAULT 'ok',
                        error_code varchar(64) NULL,
                        threshold_profile varchar(128) NULL,
                        metadata_json text NULL,
                        created_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc')
                    );
                    """),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_comment_id",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_comment_id ON comment_moderation_signal(comment_id);"),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_provider_time",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_provider_time ON comment_moderation_signal(provider, created_at_utc DESC);"),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_label_confidence",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_label_confidence ON comment_moderation_signal(label, confidence DESC);"),
                new CreateIndexStep(
                    "idx_comment_moderation_signal_second_round",
                    "CREATE INDEX IF NOT EXISTS idx_comment_moderation_signal_second_round ON comment_moderation_signal(needs_second_round, created_at_utc DESC);")
            ]);

    private static ISchemaMigrationDescriptor BuildCommentPublicHotPathIndexMigration()
        => new SchemaMigrationDescriptor(
            "20260603-post-comment-public-hot-path-indexes",
            "Add partial indexes for public approved comment roots, replies, reply counts, and recent stats.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new CreateIndexStep(
                    "idx_comment_public_roots",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_roots
                    ON comment(article_id, id DESC)
                    WHERE parent_id IS NULL AND moderation_status = 1 AND is_deleted = false;
                    """),
                new CreateIndexStep(
                    "idx_comment_public_replies",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_replies
                    ON comment(article_id, root_id, id ASC)
                    WHERE parent_id IS NOT NULL AND moderation_status = 1 AND is_deleted = false;
                    """),
                new CreateIndexStep(
                    "idx_comment_public_reply_count",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_reply_count
                    ON comment(article_id, root_id)
                    WHERE parent_id IS NOT NULL AND moderation_status = 1 AND is_deleted = false;
                    """),
                new CreateIndexStep(
                    "idx_comment_public_create_time_desc",
                    """
                    CREATE INDEX IF NOT EXISTS idx_comment_public_create_time_desc
                    ON comment(create_time DESC)
                    WHERE moderation_status = 1 AND is_deleted = false;
                    """)
            ]);
}
