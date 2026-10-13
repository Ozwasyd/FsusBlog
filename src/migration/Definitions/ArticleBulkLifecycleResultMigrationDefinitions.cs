namespace FsusBlog.Migration.Definitions;

/// <summary>
/// Additive source definition only: unregistered, online-unclassified, and held from activation.
/// PostCodeFirst is descriptor ordering, not an online Expand classification. These tables store
/// bound original outcomes and append-only recovery observations; storage alone grants no
/// permission, transaction admission, commit proof, or zero-write proof.
/// </summary>
internal static class ArticleBulkLifecycleResultMigrationDefinitions
{
    internal const string MigrationId = "20261013-post-article-bulk-lifecycle-result";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add bound article Bulk group results and append-only recovery observations.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS article_bulk_group_result (
                        group_idempotency_key varchar(71) PRIMARY KEY
                            CHECK (group_idempotency_key ~ '^sha256:[0-9a-f]{64}$'),
                        execution_identity_digest varchar(71) NOT NULL UNIQUE
                            CHECK (execution_identity_digest ~ '^sha256:[0-9a-f]{64}$'),
                        request_digest varchar(71) NOT NULL
                            CHECK (request_digest ~ '^sha256:[0-9a-f]{64}$'),
                        plan_digest varchar(71) NOT NULL
                            CHECK (plan_digest ~ '^sha256:[0-9a-f]{64}$'),
                        frozen_set_digest varchar(71) NOT NULL
                            CHECK (frozen_set_digest ~ '^sha256:[0-9a-f]{64}$'),
                        registry_digest varchar(71) NOT NULL
                            CHECK (registry_digest ~ '^sha256:[0-9a-f]{64}$'),
                        parameters_digest varchar(71) NOT NULL
                            CHECK (parameters_digest ~ '^sha256:[0-9a-f]{64}$'),
                        binding_digest varchar(71) NOT NULL
                            CHECK (binding_digest ~ '^sha256:[0-9a-f]{64}$'),
                        actor_authority_digest varchar(71) NOT NULL
                            CHECK (actor_authority_digest ~ '^sha256:[0-9a-f]{64}$'),
                        policy_digest varchar(71) NOT NULL
                            CHECK (policy_digest ~ '^sha256:[0-9a-f]{64}$'),
                        permission_policy_digest varchar(71) NOT NULL
                            CHECK (permission_policy_digest ~ '^sha256:[0-9a-f]{64}$'),
                        source_build_digest varchar(71) NOT NULL
                            CHECK (source_build_digest ~ '^sha256:[0-9a-f]{64}$'),
                        content_digest varchar(71) NOT NULL
                            CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
                        actor_user_id varchar(256) NOT NULL
                            CHECK (actor_user_id = btrim(actor_user_id) AND actor_user_id <> ''),
                        site_id varchar(256) NOT NULL
                            CHECK (site_id = btrim(site_id) AND site_id <> ''),
                        source_commit varchar(40) NOT NULL
                            CHECK (source_commit ~ '^[0-9a-f]{40}$'),
                        operation_id varchar(128) NOT NULL
                            CHECK (operation_id = btrim(operation_id) AND operation_id <> ''),
                        original_outcome integer NOT NULL CHECK (original_outcome BETWEEN 0 AND 3),
                        original_json text NOT NULL CHECK (octet_length(original_json) BETWEEN 1 AND 16777216),
                        created_at_utc timestamp without time zone NOT NULL
                    );

                    CREATE TABLE IF NOT EXISTS article_bulk_group_recovery_observation (
                        group_idempotency_key varchar(71) NOT NULL
                            REFERENCES article_bulk_group_result(group_idempotency_key) ON DELETE RESTRICT,
                        ordinal bigint NOT NULL CHECK (ordinal BETWEEN 1 AND 32768),
                        observation_id uuid NOT NULL,
                        original_result_digest varchar(71) NOT NULL
                            CHECK (original_result_digest ~ '^sha256:[0-9a-f]{64}$'),
                        previous_observation_digest varchar(71) NOT NULL
                            CHECK (previous_observation_digest ~ '^sha256:[0-9a-f]{64}$'),
                        content_digest varchar(71) NOT NULL
                            CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
                        observation_json text NOT NULL
                            CHECK (octet_length(observation_json) BETWEEN 1 AND 16777216),
                        observed_at_utc timestamp without time zone NOT NULL,
                        PRIMARY KEY (group_idempotency_key, ordinal),
                        UNIQUE (group_idempotency_key, observation_id)
                    );
                    """)
            ]);
}
