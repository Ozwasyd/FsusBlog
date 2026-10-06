namespace FsusBlog.Migration.Definitions;

internal static class ArticlePropertyDefinitionCommandHistoryMigrationDefinitions
{
    internal const string MigrationId = "20261002-post-article-property-definition-command-history";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add forward-only original PropertyDefinition command history bound to receipts and authenticated audit chains without rewriting legacy owners.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "article_property_definition_history",
                    """
                    CREATE TABLE IF NOT EXISTS article_property_definition_history (
                        owner_user_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        history_version integer NOT NULL,
                        genesis_digest varchar(64) NOT NULL,
                        revision bigint NOT NULL,
                        head_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_user_id, site_scope),
                        CONSTRAINT fk_article_property_history_owner
                            FOREIGN KEY (owner_user_id, site_scope)
                            REFERENCES article_property_definition_owner(owner_user_id, site_scope)
                            ON DELETE RESTRICT,
                        CONSTRAINT ck_article_property_history_version CHECK (history_version = 1),
                        CONSTRAINT ck_article_property_history_revision CHECK (revision >= 0),
                        CONSTRAINT ck_article_property_history_digests CHECK (
                            genesis_digest ~ '^[0-9a-f]{64}$'
                            AND head_digest ~ '^[0-9a-f]{64}$')
                    );
                    """),
                new EnsureTableStep(
                    "article_property_definition_command",
                    """
                    CREATE TABLE IF NOT EXISTS article_property_definition_command (
                        owner_user_id bigint NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        sequence bigint NOT NULL,
                        history_version integer NOT NULL,
                        command_kind varchar(32) NOT NULL,
                        definition_id uuid NOT NULL,
                        receipt_id uuid NOT NULL,
                        actor_admin_principal_id bigint NOT NULL,
                        request_id uuid NOT NULL,
                        command_payload bytea NOT NULL,
                        affected_value_count bigint NULL,
                        previous_digest varchar(64) NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        PRIMARY KEY (owner_user_id, site_scope, sequence),
                        CONSTRAINT fk_article_property_command_history
                            FOREIGN KEY (owner_user_id, site_scope)
                            REFERENCES article_property_definition_history(owner_user_id, site_scope)
                            ON DELETE RESTRICT,
                        CONSTRAINT fk_article_property_command_receipt
                            FOREIGN KEY (receipt_id)
                            REFERENCES article_property_definition_receipt(receipt_id)
                            ON DELETE RESTRICT,
                        CONSTRAINT ux_article_property_command_receipt UNIQUE (receipt_id),
                        CONSTRAINT ux_article_property_command_request UNIQUE (actor_admin_principal_id, request_id),
                        CONSTRAINT ck_article_property_command_version CHECK (history_version = 1),
                        CONSTRAINT ck_article_property_command_sequence CHECK (sequence >= 1),
                        CONSTRAINT ck_article_property_command_kind CHECK (
                            command_kind IN ('create', 'change-settings', 'rename', 'deprecate', 'delete')),
                        CONSTRAINT ck_article_property_command_actor CHECK (actor_admin_principal_id > 0),
                        CONSTRAINT ck_article_property_command_payload CHECK (
                            octet_length(command_payload) BETWEEN 1 AND 1048576),
                        CONSTRAINT ck_article_property_command_affected CHECK (
                            affected_value_count IS NULL OR affected_value_count >= 0),
                        CONSTRAINT ck_article_property_command_digests CHECK (
                            previous_digest ~ '^[0-9a-f]{64}$'
                            AND content_digest ~ '^[0-9a-f]{64}$')
                    );
                    """)
            ]);
}
