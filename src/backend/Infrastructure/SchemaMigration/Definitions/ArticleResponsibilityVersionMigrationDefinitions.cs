namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ArticleResponsibilityVersionMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-article-responsibility-version";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Make article responsibility snapshots append-only and preserve exact publication/outbox coordinates.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep(
                    "article_responsibility_snapshot",
                    "responsibility_version",
                    "integer NOT NULL DEFAULT 1"),
                new EnsureColumnStep(
                    "article_responsibility_snapshot",
                    "previous_snapshot_id",
                    "bigint NULL"),
                new EnsureColumnStep(
                    "article_mutation_outbox",
                    "responsibility_snapshot_id",
                    "bigint NULL"),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('article_responsibility_snapshot') IS NOT NULL THEN
                        DROP INDEX IF EXISTS ux_article_responsibility_revision;
                        DROP INDEX IF EXISTS idx_article_responsibility_article_revision;

                        ALTER TABLE article_responsibility_snapshot
                            DROP CONSTRAINT IF EXISTS ck_article_responsibility_version_positive;
                        ALTER TABLE article_responsibility_snapshot
                            ADD CONSTRAINT ck_article_responsibility_version_positive
                            CHECK (responsibility_version > 0);

                        ALTER TABLE article_responsibility_snapshot
                            DROP CONSTRAINT IF EXISTS fk_article_responsibility_previous_snapshot;
                        ALTER TABLE article_responsibility_snapshot
                            ADD CONSTRAINT fk_article_responsibility_previous_snapshot
                            FOREIGN KEY (previous_snapshot_id)
                            REFERENCES article_responsibility_snapshot(id)
                            ON DELETE RESTRICT;

                        CREATE UNIQUE INDEX IF NOT EXISTS ux_article_responsibility_revision_version
                            ON article_responsibility_snapshot(article_revision_id, responsibility_version);
                        CREATE INDEX IF NOT EXISTS idx_article_responsibility_article_revision
                            ON article_responsibility_snapshot(article_id, article_revision_id, responsibility_version DESC);
                    END IF;
                    END $$;
                    """),
                new BackfillSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('article_publication') IS NOT NULL
                       AND to_regclass('article_responsibility_snapshot') IS NOT NULL THEN
                    EXECUTE $migration$
                        UPDATE article_publication publication
                        SET responsibility_snapshot_id = responsibility.id
                        FROM article_responsibility_snapshot responsibility
                        WHERE publication.responsibility_snapshot_id IS NULL
                          AND responsibility.article_id = publication.article_id
                          AND responsibility.article_revision_id = publication.article_revision_id
                          AND responsibility.responsibility_version = 1
                    $migration$;
                    END IF;
                    END $$;
                    """),
                new BackfillSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('article_mutation_outbox') IS NOT NULL
                       AND to_regclass('article_responsibility_snapshot') IS NOT NULL THEN
                    EXECUTE $migration$
                        UPDATE article_mutation_outbox event
                        SET responsibility_snapshot_id = responsibility.id
                        FROM article_responsibility_snapshot responsibility
                        WHERE event.responsibility_snapshot_id IS NULL
                          AND responsibility.article_id = event.aggregate_id
                          AND responsibility.article_revision_id = event.article_revision_id
                          AND responsibility.responsibility_version = 1
                    $migration$;
                    END IF;
                    END $$;
                    """),
                new AssertSqlStep(
                    "Responsibility versions remain positive and unique per article revision.",
                    """
                    DO $$
                    DECLARE invalid_versions boolean;
                    BEGIN
                    IF to_regclass('article_responsibility_snapshot') IS NOT NULL THEN
                        EXECUTE $migration$
                            SELECT EXISTS (
                                SELECT 1
                                FROM article_responsibility_snapshot
                                GROUP BY article_revision_id, responsibility_version
                                HAVING responsibility_version <= 0 OR COUNT(*) > 1
                            )
                        $migration$ INTO invalid_versions;
                        IF invalid_versions THEN
                            RAISE EXCEPTION 'Article responsibility versions are invalid or duplicated.';
                        END IF;
                    END IF;
                    END $$;
                    """),
                new AssertSqlStep(
                    "Published responsibility pointers resolve to the same article revision.",
                    """
                    DO $$
                    DECLARE invalid_coordinates boolean;
                    BEGIN
                    IF to_regclass('article_publication') IS NOT NULL
                       AND to_regclass('article_responsibility_snapshot') IS NOT NULL THEN
                        EXECUTE $migration$
                            SELECT EXISTS (
                                SELECT 1
                                FROM article_publication publication
                                JOIN article_responsibility_snapshot responsibility
                                  ON responsibility.id = publication.responsibility_snapshot_id
                                WHERE responsibility.article_id <> publication.article_id
                                   OR responsibility.article_revision_id <> publication.article_revision_id
                            )
                        $migration$ INTO invalid_coordinates;
                        IF invalid_coordinates THEN
                            RAISE EXCEPTION 'Article publication responsibility coordinates do not resolve.';
                        END IF;
                    END IF;
                    END $$;
                    """)
            ]);
}
