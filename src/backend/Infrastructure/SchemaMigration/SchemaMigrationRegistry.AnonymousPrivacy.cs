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
                    UPDATE anonymous_credential_issuance_audit
                    SET trace_id = NULL,
                        created_at_utc = date_trunc('hour', created_at_utc)
                    WHERE trace_id IS NOT NULL
                       OR created_at_utc <> date_trunc('hour', created_at_utc);
                    """)
            ]);
}
