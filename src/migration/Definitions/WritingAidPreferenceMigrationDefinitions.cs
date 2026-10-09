namespace FsusBlog.Migration.Definitions;

internal static class WritingAidPreferenceMigrationDefinitions
{
    internal const string MigrationId = "20261008-post-writing-aid-preferences";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add independent user-site writing aid facts and durable command idempotency.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS user_authoring_preference (
                        user_scope varchar(128) NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        schema_version integer NOT NULL,
                        focus_enabled boolean NOT NULL,
                        typewriter_enabled boolean NOT NULL,
                        immersive_enabled boolean NOT NULL,
                        typography_payload text NULL,
                        revision bigint NOT NULL,
                        content_digest varchar(64) NOT NULL,
                        updated_at timestamp without time zone NOT NULL,
                        PRIMARY KEY (user_scope, site_scope),
                        CONSTRAINT ck_writing_aid_preference_owner CHECK (
                            user_scope ~ '^(account|admin):[1-9][0-9]*$'
                            AND split_part(user_scope, ':', 2)::numeric <= 9007199254740991
                            AND length(site_scope) > 0 AND btrim(site_scope) = site_scope
                            AND site_scope !~ '[[:cntrl:]]'),
                        CONSTRAINT ck_authoring_preference_typography CHECK (typography_payload IS NULL OR length(typography_payload) BETWEEN 1 AND 2048),
                        CONSTRAINT ck_writing_aid_preference_schema CHECK (schema_version = 1),
                        CONSTRAINT ck_writing_aid_preference_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
                        CONSTRAINT ck_writing_aid_preference_digest CHECK (content_digest ~ '^[0-9a-f]{64}$')
                    );
                    CREATE TABLE IF NOT EXISTS user_authoring_preference_operation (
                        user_scope varchar(128) NOT NULL,
                        site_scope varchar(128) NOT NULL,
                        operation_id uuid NOT NULL,
                        device_scope varchar(71) NOT NULL,
                        domain varchar(16) NOT NULL,
                        request_digest varchar(64) NOT NULL,
                        receipt text NOT NULL,
                        committed_at timestamp without time zone NOT NULL,
                        PRIMARY KEY (user_scope, site_scope, operation_id),
                        FOREIGN KEY (user_scope, site_scope)
                            REFERENCES user_authoring_preference(user_scope, site_scope) ON DELETE CASCADE,
                        CONSTRAINT ck_authoring_operation_domain CHECK (domain IN ('writing-aids', 'typography')),
                        CONSTRAINT ck_authoring_operation_device CHECK (device_scope ~ '^device:[0-9a-f]{64}$'),
                        CONSTRAINT ck_writing_aid_operation_digest CHECK (request_digest ~ '^[0-9a-f]{64}$'),
                        CONSTRAINT ck_writing_aid_operation_receipt CHECK (length(receipt) BETWEEN 1 AND 4096)
                    );
                    """)
            ]);
}
