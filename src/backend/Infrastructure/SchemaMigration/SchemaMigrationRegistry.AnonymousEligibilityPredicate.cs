namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public sealed partial class SchemaMigrationRegistry
{
    private static ISchemaMigrationDescriptor BuildAnonymousEligibilityPredicatePreCodeFirstMigration()
        => new SchemaMigrationDescriptor(
            "20260716-pre-anonymous-eligibility-predicate",
            "Expand comment storage with low-cardinality anonymous policy predicates.",
            SchemaMigrationPhase.PreCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureColumnStep("comment", "anonymous_rate_class", "varchar(16) NULL"),
                new EnsureColumnStep("comment", "anonymous_requires_moderation", "boolean NULL")
            ]);

    private static ISchemaMigrationDescriptor BuildAnonymousEligibilityPredicateMigration()
        => new SchemaMigrationDescriptor(
            "20260716-post-anonymous-eligibility-predicate",
            "Erase precise anonymous credential attributes and retain only policy-minimal predicates.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    UPDATE comment
                    SET credential_level = NULL,
                        reputation_bucket = NULL,
                        account_age_bucket = NULL
                    WHERE author_mode = 'zk_anonymous'
                      AND (
                          credential_level IS NOT NULL
                          OR reputation_bucket IS NOT NULL
                          OR account_age_bucket IS NOT NULL
                      );
                    """)
            ]);
}
