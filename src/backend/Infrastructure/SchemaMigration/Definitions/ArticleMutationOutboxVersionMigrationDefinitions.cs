namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class ArticleMutationOutboxVersionMigrationDefinitions
{
    internal const string MigrationId = "20260720-pre-article-mutation-outbox-version";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Version article mutation envelopes and persist immutable rights and responsibility coordinates.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('article_mutation_outbox') IS NOT NULL THEN
                        EXECUTE 'ALTER TABLE article_mutation_outbox
                            ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 1,
                            ADD COLUMN IF NOT EXISTS rights_snapshot_id bigint NULL,
                            ADD COLUMN IF NOT EXISTS responsibility_version integer NULL';
                    END IF;
                    IF to_regclass('article_responsibility_snapshot') IS NOT NULL THEN
                        EXECUTE 'ALTER TABLE article_responsibility_snapshot
                            ADD COLUMN IF NOT EXISTS responsibility_version integer NOT NULL DEFAULT 1';
                    END IF;
                    END $$;
                    """),
                new BackfillSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('article_mutation_outbox') IS NOT NULL
                       AND to_regclass('article_publication') IS NOT NULL THEN
                    EXECUTE $migration$
                        UPDATE article_mutation_outbox event
                        SET rights_snapshot_id = publication.rights_snapshot_id,
                            responsibility_snapshot_id = COALESCE(
                                event.responsibility_snapshot_id,
                                publication.responsibility_snapshot_id)
                        FROM article_publication publication
                        WHERE publication.id = event.article_publication_id
                          AND (
                              event.rights_snapshot_id IS NULL
                              OR event.responsibility_snapshot_id IS NULL
                          )
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
                        SET responsibility_version = responsibility.responsibility_version
                        FROM article_responsibility_snapshot responsibility
                        WHERE responsibility.id = event.responsibility_snapshot_id
                          AND event.responsibility_version IS NULL
                    $migration$;
                    END IF;
                    END $$;
                    """),
                new RawSqlStep(
                    """
                    DO $$
                    BEGIN
                    IF to_regclass('article_mutation_outbox') IS NOT NULL THEN
                        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_article_mutation_outbox_version_coordinate
                            ON article_mutation_outbox(aggregate_id, article_publication_id, article_revision_id, id)';
                    END IF;
                    END $$;
                    """),
                new AssertSqlStep(
                    "Versioned article mutation events preserve exact immutable coordinates.",
                    """
                    DO $$
                    DECLARE invalid_coordinates boolean;
                    BEGIN
                    IF to_regclass('article_mutation_outbox') IS NOT NULL THEN
                        EXECUTE $migration$
                            SELECT EXISTS (
                                SELECT 1
                                FROM article_mutation_outbox event
                                WHERE event.schema_version >= 2
                                  AND (
                                      event.article_revision_id IS NULL
                                      OR event.revision_no IS NULL
                                      OR event.rights_snapshot_id IS NULL
                                  )
                            )
                        $migration$ INTO invalid_coordinates;
                        IF invalid_coordinates THEN
                            RAISE EXCEPTION 'Versioned article mutation event has incomplete immutable coordinates.';
                        END IF;
                    END IF;
                    END $$;
                    """)
            ]);
}
