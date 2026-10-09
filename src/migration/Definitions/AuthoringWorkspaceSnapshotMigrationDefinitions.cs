namespace FsusBlog.Migration.Definitions;

internal static class AuthoringWorkspaceSnapshotMigrationDefinitions
{
    internal const string MigrationId = "20261008-post-authoring-workspace-snapshot";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Add one bounded server-owned workspace snapshot per admin principal and site.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new RawSqlStep("""
                    CREATE TABLE IF NOT EXISTS authoring_workspace_snapshot (
                        user_id bigint NOT NULL REFERENCES admin_principal(id) ON DELETE CASCADE,
                        site_id varchar(128) NOT NULL,
                        workspace_id varchar(7) NOT NULL CHECK (workspace_id = 'default'),
                        revision bigint NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
                        snapshot_bytes bytea NOT NULL CHECK (octet_length(snapshot_bytes) BETWEEN 1 AND 65536),
                        PRIMARY KEY (user_id, site_id, workspace_id)
                    );
                    """)
            ]);
}
