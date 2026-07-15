namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public sealed partial class SchemaMigrationRegistry
{
    private static ISchemaMigrationDescriptor BuildBlindCredentialIssuancePrivacyMigration()
        => new SchemaMigrationDescriptor(
            "20260715-post-blind-credential-issuance-privacy",
            "Purge request correlation from blind credential issuance quota records.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    DO $$
                    BEGIN
                        IF EXISTS (
                            SELECT 1
                            FROM information_schema.columns
                            WHERE table_schema = 'public'
                              AND table_name = 'anonymous_credential_issuance_audit'
                              AND column_name = 'trace_id'
                        ) THEN
                            UPDATE anonymous_credential_issuance_audit
                            SET trace_id = NULL,
                                created_at_utc = date_trunc('hour', created_at_utc)
                            WHERE trace_id IS NOT NULL
                               OR created_at_utc <> date_trunc('hour', created_at_utc);
                        ELSE
                            UPDATE anonymous_credential_issuance_audit
                            SET created_at_utc = date_trunc('hour', created_at_utc)
                            WHERE created_at_utc <> date_trunc('hour', created_at_utc);
                        END IF;
                    END $$;
                    """)
            ]);
}
