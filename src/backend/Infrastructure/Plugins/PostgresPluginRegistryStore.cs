using System.Data.Common;
using System.Text.Json;
using System.Text.Json.Serialization;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Plugins;

/// <summary>
/// PostgreSQL Registry shared by every application node. Package bytes remain in
/// the same durable row as their verified manifest and lifecycle coordinate.
/// </summary>
public sealed class PostgresPluginRegistryStore(ISqlSugarClient db) : IPluginRegistryStore
{
    private const string SelectColumns = """
        id,
        manifest_json::text,
        install_state,
        enabled,
        package_bytes,
        package_sha256,
        installed_at_utc,
        updated_at_utc,
        version
        """;

    private static readonly JsonSerializerOptions s_manifestJsonOptions = new(JsonSerializerDefaults.Web)
    {
        Converters =
        {
            new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false)
        }
    };

    public async Task<PluginRegistryEntry?> FindAsync(
        string pluginId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {SelectColumns}
            FROM plugin_registry
            WHERE id = @Id;
            """,
            new SugarParameter[]
            {
                new("@Id", pluginId)
            }).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadEntry(reader)
            : null;
    }

    public async Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            SELECT {SelectColumns}
            FROM plugin_registry
            ORDER BY id;
            """).ConfigureAwait(false);
        var entries = new List<PluginRegistryEntry>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            entries.Add(ReadEntry(reader));
        }
        return entries;
    }

    public async Task<bool> TryInstallAsync(
        PluginRegistryEntry entry,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int inserted = await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO plugin_registry (
                id,
                name,
                plugin_version,
                runtime_type,
                manifest_json,
                install_state,
                enabled,
                package_bytes,
                package_sha256,
                installed_at_utc,
                updated_at_utc,
                version)
            VALUES (
                @Id,
                @Name,
                @PluginVersion,
                @RuntimeType,
                CAST(@ManifestJson AS jsonb),
                @InstallState,
                @Enabled,
                @PackageBytes,
                @PackageSha256,
                @InstalledAtUtc,
                @UpdatedAtUtc,
                @Version)
            ON CONFLICT (id) DO NOTHING;
            """,
            CreateParameters(entry, includeExpectedVersion: false)).ConfigureAwait(false);
        return inserted == 1;
    }

    public async Task<PluginRegistryEntry?> TryUpdateAsync(
        PluginRegistryEntry entry,
        long expectedVersion,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"""
            UPDATE plugin_registry
            SET install_state = @InstallState,
                enabled = @Enabled,
                package_bytes = @PackageBytes,
                updated_at_utc = @UpdatedAtUtc,
                version = version + 1
            WHERE id = @Id
              AND version = @ExpectedVersion
            RETURNING {SelectColumns};
            """,
            CreateParameters(entry, includeExpectedVersion: true, expectedVersion)).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            ? ReadEntry(reader)
            : null;
    }

    private static SugarParameter[] CreateParameters(
        PluginRegistryEntry entry,
        bool includeExpectedVersion,
        long expectedVersion = 0)
    {
        var parameters = new List<SugarParameter>
        {
            new("@Id", entry.Manifest.Id),
            new("@Name", entry.Manifest.Name),
            new("@PluginVersion", entry.Manifest.Version),
            new("@RuntimeType", entry.Manifest.Runtime.Type.ToString().ToLowerInvariant()),
            new("@ManifestJson", JsonSerializer.Serialize(entry.Manifest, s_manifestJsonOptions)),
            new("@InstallState", (int)entry.InstallState),
            new("@Enabled", entry.Enabled),
            new("@PackageBytes", entry.PackageBytes),
            new("@PackageSha256", entry.PackageSha256),
            new("@InstalledAtUtc", entry.InstalledAtUtc.UtcDateTime),
            new("@UpdatedAtUtc", entry.UpdatedAtUtc.UtcDateTime),
            new("@Version", entry.Version)
        };
        if (includeExpectedVersion)
        {
            parameters.Add(new SugarParameter("@ExpectedVersion", expectedVersion));
        }
        return [.. parameters];
    }

    private static PluginRegistryEntry ReadEntry(DbDataReader reader)
    {
        PluginManifest manifest = JsonSerializer.Deserialize<PluginManifest>(
            reader.GetString(1),
            s_manifestJsonOptions)
            ?? throw new InvalidDataException("Persisted plugin manifest cannot be null.");
        return new PluginRegistryEntry(
            manifest,
            (PluginInstallState)reader.GetInt32(2),
            reader.GetBoolean(3),
            reader.GetFieldValue<byte[]>(4),
            reader.GetFieldValue<byte[]>(5),
            ReadTimestamp(reader, 6),
            ReadTimestamp(reader, 7),
            reader.GetInt64(8));
    }

    private static DateTimeOffset ReadTimestamp(DbDataReader reader, int ordinal)
        => new(DateTime.SpecifyKind(reader.GetDateTime(ordinal), DateTimeKind.Utc));
}
