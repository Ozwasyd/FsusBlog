namespace FsusBlog.Migration.Definitions;

/// <summary>Expand the original common registry after genuine receipt producers are supplied.</summary>
internal static class ArticleSourceReceiptOriginsMigrationDefinitions
{
    internal const string MigrationId = "20261018-post-article-source-receipt-origins";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Admit real taxonomy and display-locale receipts to the existing single source family.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    ALTER TABLE article_source_observation
                        DROP CONSTRAINT IF EXISTS ck_article_source_observation_origin;
                    ALTER TABLE article_source_observation ADD CONSTRAINT ck_article_source_observation_origin
                        CHECK (origin_kind IN ('article', 'property-definition', 'security-policy',
                            'property-value', 'taxonomy', 'display-locale')
                            AND length(origin_key) > 0 AND length(origin_facts) > 0);
                    """)
            ]);
}
