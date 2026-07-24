namespace FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;

internal static class PluginRegistryMigrationDefinitions
{
    internal const string MigrationId = "20260724-post-plugin-registry";

    internal static ISchemaMigrationDescriptor BuildMigration()
        => new SchemaMigrationDescriptor(
            MigrationId,
            "Persist verified plugin packages and lifecycle state for cluster-wide Registry reads.",
            SchemaMigrationPhase.PostCodeFirst,
            Transactional: true,
            Steps:
            [
                new EnsureTableStep(
                    "plugin_registry",
                    """
                    CREATE TABLE IF NOT EXISTS plugin_registry (
                        id varchar(128) PRIMARY KEY,
                        name varchar(128) NOT NULL,
                        plugin_version varchar(64) NOT NULL,
                        runtime_type varchar(32) NOT NULL,
                        manifest_json jsonb NOT NULL,
                        install_state integer NOT NULL,
                        enabled boolean NOT NULL,
                        package_bytes bytea NOT NULL,
                        package_sha256 bytea NOT NULL,
                        installed_at_utc timestamp NOT NULL,
                        updated_at_utc timestamp NOT NULL,
                        version bigint NOT NULL,
                        CONSTRAINT ck_plugin_registry_id
                            CHECK (id ~ '^[a-z0-9]+([.-][a-z0-9]+){2,}$'),
                        CONSTRAINT ck_plugin_registry_install_state
                            CHECK (install_state BETWEEN 0 AND 6),
                        CONSTRAINT ck_plugin_registry_enabled_state
                            CHECK ((enabled AND install_state = 2) OR (NOT enabled AND install_state <> 2)),
                        CONSTRAINT ck_plugin_registry_sha256
                            CHECK (octet_length(package_sha256) = 32),
                        CONSTRAINT ck_plugin_registry_version
                            CHECK (version > 0),
                        CONSTRAINT ck_plugin_registry_uninstalled_package
                            CHECK (install_state <> 6 OR octet_length(package_bytes) = 0)
                    );
                    """),
                new CreateIndexStep(
                    "idx_plugin_registry_runtime_state",
                    "CREATE INDEX IF NOT EXISTS idx_plugin_registry_runtime_state ON plugin_registry(runtime_type, install_state, id);"),
                new CreateIndexStep(
                    "idx_plugin_registry_updated",
                    "CREATE INDEX IF NOT EXISTS idx_plugin_registry_updated ON plugin_registry(updated_at_utc, id);")
            ]);
}
