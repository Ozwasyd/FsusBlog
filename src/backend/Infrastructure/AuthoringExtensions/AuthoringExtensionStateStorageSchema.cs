namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Leaf schema proposal for the parent migration owner. The store never executes DDL.
/// Registration, current-schema inventory and production activation are separate work.
/// The hash-only settlement companion is required before activating the updated owner;
/// existing settled operations without recorded observations cannot be backfilled by retry.
/// </summary>
public static class AuthoringExtensionStateStorageSchema
{
    public const string CreateTablesSql = """
        CREATE TABLE authoring_extension_state_scope (
            scope_id varchar(64) COLLATE "C" PRIMARY KEY CHECK (scope_id ~ '^[0-9a-f]{64}$'),
            revision bigint NOT NULL CHECK (revision >= 0),
            fence varchar(64) COLLATE "C" NULL CHECK (fence IS NULL OR fence ~ '^[0-9a-f]{64}$'),
            payload bytea NOT NULL CHECK (octet_length(payload) <= 84934656)
        );
        CREATE TABLE authoring_extension_state_migration (
            plan_id varchar(64) COLLATE "C" PRIMARY KEY CHECK (plan_id ~ '^[0-9a-f]{64}$'),
            plan_sha256 varchar(64) COLLATE "C" UNIQUE NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
            from_scope_id varchar(64) COLLATE "C" NOT NULL REFERENCES authoring_extension_state_scope(scope_id),
            to_scope_id varchar(64) COLLATE "C" NOT NULL REFERENCES authoring_extension_state_scope(scope_id),
            phase smallint NOT NULL CHECK (phase BETWEEN 0 AND 3),
            CHECK (from_scope_id <> to_scope_id)
        );
        CREATE TABLE authoring_extension_state_backup (
            plan_id varchar(64) COLLATE "C" NOT NULL REFERENCES authoring_extension_state_migration(plan_id),
            scope_id varchar(64) COLLATE "C" NOT NULL REFERENCES authoring_extension_state_scope(scope_id),
            payload bytea NOT NULL CHECK (octet_length(payload) <= 84934656),
            PRIMARY KEY (plan_id, scope_id)
        );
        CREATE INDEX ix_authoring_extension_state_backup_scope
            ON authoring_extension_state_backup(scope_id, plan_id);
        CREATE TABLE authoring_extension_state_settlement (
            plan_id varchar(64) COLLATE "C" PRIMARY KEY REFERENCES authoring_extension_state_migration(plan_id),
            observation_sha256 varchar(64) COLLATE "C" NOT NULL CHECK (observation_sha256 ~ '^[0-9a-f]{64}$')
        );
        """;
}
