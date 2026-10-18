namespace FsusBlog.Migration.Definitions;

/// <summary>Explicit migration only. Registration and source enrollment belong to the original owner.</summary>
internal static class UserLocaleMutationReceiptMigrationDefinitions
{
    internal const string MigrationId = "20261018-post-user-locale-mutation-receipt";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add immutable actual display-locale preference transition receipts, independent of source generation.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS user_locale_mutation_receipt (
                        receipt_id uuid PRIMARY KEY,
                        account_id integer NOT NULL CHECK (account_id > 0),
                        mutation_kind varchar(16) NOT NULL,
                        compensates_receipt_id uuid NULL REFERENCES user_locale_mutation_receipt(receipt_id),
                        before_state jsonb NULL,
                        after_state jsonb NULL,
                        CONSTRAINT ck_user_locale_receipt_kind CHECK (
                            (mutation_kind = 'update' AND compensates_receipt_id IS NULL AND after_state IS NOT NULL)
                            OR (mutation_kind = 'compensation' AND compensates_receipt_id IS NOT NULL
                                AND before_state IS NOT NULL)),
                        CONSTRAINT ck_user_locale_receipt_transition CHECK (
                            before_state IS DISTINCT FROM after_state)
                    );
                    CREATE UNIQUE INDEX IF NOT EXISTS ux_user_locale_receipt_compensation
                        ON user_locale_mutation_receipt(compensates_receipt_id)
                        WHERE compensates_receipt_id IS NOT NULL;

                    CREATE OR REPLACE FUNCTION reject_user_locale_receipt_mutation()
                    RETURNS trigger LANGUAGE plpgsql AS $$
                    BEGIN
                        RAISE EXCEPTION 'locale_receipt_immutable' USING ERRCODE = '55000';
                    END;
                    $$;
                    DO $$
                    BEGIN
                        IF NOT EXISTS (SELECT 1 FROM pg_trigger
                            WHERE tgrelid = 'user_locale_mutation_receipt'::regclass
                                AND tgname = 'tr_user_locale_receipt_immutable') THEN
                            CREATE TRIGGER tr_user_locale_receipt_immutable
                            BEFORE UPDATE OR DELETE OR TRUNCATE ON user_locale_mutation_receipt
                            FOR EACH STATEMENT EXECUTE FUNCTION reject_user_locale_receipt_mutation();
                        END IF;
                    END;
                    $$;
                    """)
            ]);
}
