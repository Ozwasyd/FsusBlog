namespace FsusBlog.Migration.Definitions;

/// <summary>Unregistered additive descriptor; the original migration owner registers it serially.</summary>
internal static class TaxonomyMutationReceiptMigrationDefinitions
{
    internal const string MigrationId = "20261018-post-taxonomy-mutation-receipt";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Preserve original taxonomy mutation identity and affected articles as immutable receipts.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS taxonomy_mutation_receipt (
                        receipt_id uuid PRIMARY KEY,
                        target_kind varchar(16) NOT NULL CHECK (target_kind IN ('category', 'tag')),
                        operation varchar(16) NOT NULL CHECK (operation IN ('create', 'update', 'delete')),
                        target_id integer NOT NULL CHECK (target_id > 0),
                        before_identity jsonb NULL,
                        after_identity jsonb NULL,
                        affected_article_ids integer[] NOT NULL,
                        receipt_facts text NOT NULL,
                        CONSTRAINT ck_taxonomy_mutation_receipt_identity CHECK (
                            (operation = 'create' AND before_identity IS NULL AND after_identity IS NOT NULL)
                            OR (operation = 'update' AND before_identity IS NOT NULL AND after_identity IS NOT NULL
                                AND before_identity <> after_identity)
                            OR (operation = 'delete' AND before_identity IS NOT NULL AND after_identity IS NULL)),
                        CONSTRAINT ck_taxonomy_mutation_receipt_target CHECK (
                            (before_identity IS NULL OR (before_identity->>'Id')::integer = target_id)
                            AND (after_identity IS NULL OR (after_identity->>'Id')::integer = target_id)),
                        CONSTRAINT ck_taxonomy_mutation_receipt_articles CHECK (
                            array_position(affected_article_ids, NULL) IS NULL
                            AND 0 < ALL(affected_article_ids))
                    );
                    CREATE INDEX IF NOT EXISTS ix_taxonomy_mutation_receipt_target
                        ON taxonomy_mutation_receipt(target_kind, target_id);

                    CREATE OR REPLACE FUNCTION fsusblog_taxonomy_mutation_receipt_immutable()
                    RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        RAISE EXCEPTION 'taxonomy_mutation_receipt_immutable';
                    END $$;
                    DO $$
                    BEGIN
                        IF NOT EXISTS (SELECT 1 FROM pg_trigger
                            WHERE tgrelid = 'taxonomy_mutation_receipt'::regclass
                                AND tgname = 'trg_taxonomy_mutation_receipt_immutable') THEN
                            CREATE TRIGGER trg_taxonomy_mutation_receipt_immutable
                                BEFORE UPDATE OR DELETE OR TRUNCATE ON taxonomy_mutation_receipt
                                FOR EACH STATEMENT EXECUTE FUNCTION fsusblog_taxonomy_mutation_receipt_immutable();
                        END IF;
                    END $$;
                    """)
            ]);
}
