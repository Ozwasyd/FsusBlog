namespace FsusBlog.Migration.Definitions;

internal static class ArticleSourceGenerationMigrationDefinitions
{
    internal const string MigrationId = "20261018-post-article-source-generation";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Persist the single article source generation, article sequences and actual outbox event enrollments.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_source_generation (
                        family_id integer PRIMARY KEY,
                        source_generation bigint NOT NULL,
                        CONSTRAINT ck_article_source_generation_family CHECK (family_id = 1),
                        CONSTRAINT ck_article_source_generation_positive CHECK (source_generation > 0)
                    );

                    CREATE TABLE IF NOT EXISTS article_source_sequence (
                        article_id integer PRIMARY KEY,
                        source_sequence bigint NOT NULL,
                        CONSTRAINT ck_article_source_sequence_article CHECK (article_id > 0),
                        CONSTRAINT ck_article_source_sequence_positive CHECK (source_sequence > 0)
                    );

                    CREATE TABLE IF NOT EXISTS article_source_mutation (
                        event_id varchar(36) PRIMARY KEY,
                        article_id integer NOT NULL,
                        source_generation bigint NOT NULL,
                        source_sequence bigint NOT NULL,
                        event_facts text NOT NULL,
                        CONSTRAINT ck_article_source_mutation_article CHECK (article_id > 0),
                        CONSTRAINT ck_article_source_mutation_generation CHECK (source_generation > 0),
                        CONSTRAINT ck_article_source_mutation_sequence CHECK (
                            source_sequence > 0 AND source_sequence <= source_generation)
                    );

                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_source_mutation_generation
                        ON article_source_mutation(source_generation);
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_article_source_mutation_sequence
                        ON article_source_mutation(article_id, source_sequence);

                    DO $$
                    BEGIN
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_generation'::regclass
                                AND conname = 'ck_article_source_generation_family') THEN
                            ALTER TABLE article_source_generation ADD CONSTRAINT
                                ck_article_source_generation_family CHECK (family_id = 1);
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_generation'::regclass
                                AND conname = 'ck_article_source_generation_positive') THEN
                            ALTER TABLE article_source_generation ADD CONSTRAINT
                                ck_article_source_generation_positive CHECK (source_generation > 0);
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_sequence'::regclass
                                AND conname = 'ck_article_source_sequence_article') THEN
                            ALTER TABLE article_source_sequence ADD CONSTRAINT
                                ck_article_source_sequence_article CHECK (article_id > 0);
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_sequence'::regclass
                                AND conname = 'ck_article_source_sequence_positive') THEN
                            ALTER TABLE article_source_sequence ADD CONSTRAINT
                                ck_article_source_sequence_positive CHECK (source_sequence > 0);
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_mutation'::regclass
                                AND conname = 'ck_article_source_mutation_article') THEN
                            ALTER TABLE article_source_mutation ADD CONSTRAINT
                                ck_article_source_mutation_article CHECK (article_id > 0);
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_mutation'::regclass
                                AND conname = 'ck_article_source_mutation_generation') THEN
                            ALTER TABLE article_source_mutation ADD CONSTRAINT
                                ck_article_source_mutation_generation CHECK (source_generation > 0);
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                            WHERE conrelid = 'article_source_mutation'::regclass
                                AND conname = 'ck_article_source_mutation_sequence') THEN
                            ALTER TABLE article_source_mutation ADD CONSTRAINT
                                ck_article_source_mutation_sequence CHECK (
                                    source_sequence > 0 AND source_sequence <= source_generation);
                        END IF;
                    END $$;
                    """)
            ]);
}
