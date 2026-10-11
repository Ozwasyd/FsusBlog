namespace FsusBlog.Migration.Definitions;

// Source definition only: catalog/Contract admission awaits the release, retention and
// backup/restore coordinates. Never execute this SQL through an additive Expand path.
internal static class ArticleInboxCreateReceiptMigrationDefinitions
{
    internal const string MigrationId = "20261011-post-article-inbox-create-receipt";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Replace only the create receipt mode/template/status constraints with the exact explicit Inbox closure; retain immutable guards and all identity/digest constraints.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""

                    ALTER TABLE article_create_receipt
                        DROP CONSTRAINT ck_article_create_receipt_mode,
                        DROP CONSTRAINT ck_article_create_receipt_template_set,
                        DROP CONSTRAINT ck_article_create_receipt_draft_only;
                    ALTER TABLE article_create_receipt
                        ADD CONSTRAINT ck_article_create_receipt_mode CHECK (
                            create_mode IN ('blank', 'template', 'inbox')),
                        ADD CONSTRAINT ck_article_create_receipt_template_set CHECK (
                            (create_mode = 'template'
                                AND template_id IS NOT NULL
                                AND template_version_id IS NOT NULL
                                AND template_version_number IS NOT NULL
                                AND plan_digest IS NOT NULL
                                AND defaults_digest IS NOT NULL
                                AND reference_digest IS NOT NULL)
                            OR (create_mode IN ('blank', 'inbox')
                                AND template_id IS NULL
                                AND template_version_id IS NULL
                                AND template_version_number IS NULL
                                AND plan_digest IS NULL
                                AND defaults_digest IS NULL
                                AND reference_digest IS NULL)),
                        ADD CONSTRAINT ck_article_create_receipt_draft_only CHECK (
                            (create_mode IN ('blank', 'template') AND status = 'draft')
                            OR (create_mode = 'inbox' AND status = 'inbox'));
                    """)
            ]);
}
