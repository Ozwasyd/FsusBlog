namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Leaf DDL for the migration owner. Never executed by the runtime store.</summary>
public static class AuthoringExtensionApprovalStorageSchema
{
    public const string CreateTablesSql = """
        CREATE TABLE authoring_extension_approval_decision (
            decision_id varchar(64) COLLATE "C" PRIMARY KEY CHECK (decision_id ~ '^[0-9a-f]{64}$'),
            operation_sha256 varchar(64) COLLATE "C" UNIQUE NOT NULL CHECK (operation_sha256 ~ '^[0-9a-f]{64}$'),
            status smallint NOT NULL CHECK (status BETWEEN 0 AND 8),
            revision bigint NOT NULL CHECK (revision >= 0),
            protected_payload bytea NOT NULL CHECK (octet_length(protected_payload) <= 25165824)
        );
        CREATE TABLE authoring_extension_approval_event (
            decision_id varchar(64) COLLATE "C" NOT NULL REFERENCES authoring_extension_approval_decision(decision_id),
            revision bigint NOT NULL CHECK (revision >= 0),
            status smallint NOT NULL CHECK (status BETWEEN 0 AND 8),
            protected_payload bytea NOT NULL CHECK (octet_length(protected_payload) <= 25165824),
            PRIMARY KEY (decision_id, revision)
        );
        """;
}
