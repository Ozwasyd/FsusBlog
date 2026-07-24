using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Plugins;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class PluginFoundationTests
{
    [Fact]
    public async Task ReadAsync_ValidPackage_ReturnsVerifiedSnapshot()
    {
        byte[] package = CreatePackage();
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackage snapshot = await reader.ReadAsync(new MemoryStream(package));

        Assert.Equal("fsusblog.plugin.comment-guard", snapshot.Manifest.Id);
        Assert.Equal(PluginRuntimeType.Lua, snapshot.Manifest.Runtime.Type);
        Assert.Equal("config/schema.json", snapshot.ConfigSchema.Path);
        Assert.Equal("object", snapshot.ConfigSchema.Document.GetProperty("type").GetString());
        Assert.Equal(SHA256.HashData(package), snapshot.PackageSha256);
        Assert.Equal(package, snapshot.PackageBytes);
    }

    [Fact]
    public async Task ReadAsync_ChecksumMismatch_FailsBeforePackageCanBeInstalled()
    {
        byte[] package = CreatePackage(checksumOverride: new string('0', 64));
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("checksum", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadAsync_PathTraversalEntry_IsRejected()
    {
        byte[] package = CreatePackage(extraEntry: ("../escape.lua", "return true"));
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("path", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadAsync_UnknownPermissionField_IsRejected()
    {
        byte[] package = CreatePackage(manifestTransform: static json =>
            json.Replace(
                "\"database\":\"none\"",
                "\"database\":\"none\",\"process\":true",
                StringComparison.Ordinal));
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("permission", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadAsync_DuplicateManifestProperty_IsRejected()
    {
        byte[] package = CreatePackage(manifestTransform: static json =>
            json.Replace(
                "\"id\":\"fsusblog.plugin.comment-guard\"",
                "\"id\":\"fsusblog.plugin.other\",\"id\":\"fsusblog.plugin.comment-guard\"",
                StringComparison.Ordinal));
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("duplicated", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadAsync_IncompatibleHostRange_IsRejected()
    {
        byte[] package = CreatePackage(manifestTransform: static json =>
            json.Replace(
                "\">=1.3.0 <1.4.0\"",
                "\">=1.4.0 <2.0.0\"",
                StringComparison.Ordinal));
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("does not include host", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadAsync_MissingRuntimeEntry_IsRejected()
    {
        byte[] package = CreatePackage(manifestTransform: static json =>
            json.Replace("lua/main.lua", "lua/missing.lua", StringComparison.Ordinal));
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("does not exist", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ReadAsync_InvalidConfigSchema_IsRejected()
    {
        byte[] package = CreatePackage(configOverride: """{"type":"array"}""");
        var reader = new PluginPackageReader(new Version(1, 3, 0));

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("config schema", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ReadAsync_ConfiguredSignatureVerifierRejectsPackage()
    {
        byte[] package = CreatePackage();
        var reader = new PluginPackageReader(
            new Version(1, 3, 0),
            new RejectingSignatureVerifier());

        PluginPackageValidationException exception = await Assert.ThrowsAsync<PluginPackageValidationException>(
            () => reader.ReadAsync(new MemoryStream(package)));

        Assert.Contains("signature verification failed", exception.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task InstallAsync_DuplicateId_DoesNotReplaceExistingPlugin()
    {
        var store = new InMemoryPluginRegistryStore();
        var lifecycle = new PluginLifecycle(
            new PluginPackageReader(new Version(1, 3, 0)),
            store,
            TimeProvider.System);
        await lifecycle.InstallAsync(new MemoryStream(CreatePackage()));
        byte[] replacement = CreatePackage(manifestTransform: static json =>
            json.Replace("\"version\":\"1.0.0\"", "\"version\":\"1.0.1\"", StringComparison.Ordinal));

        await Assert.ThrowsAsync<PluginLifecycleException>(
            () => lifecycle.InstallAsync(new MemoryStream(replacement)));

        PluginRegistryEntry existing = Assert.Single(await store.ListAsync());
        Assert.Equal("1.0.0", existing.Manifest.Version);
        Assert.Equal(PluginInstallState.Installed, existing.InstallState);
        Assert.False(existing.Enabled);
    }

    [Fact]
    public async Task Lifecycle_UsesSharedRegistryStateAcrossNodes()
    {
        var store = new InMemoryPluginRegistryStore();
        var nodeOne = new PluginLifecycle(
            new PluginPackageReader(new Version(1, 3, 0)),
            store,
            TimeProvider.System);
        var nodeTwo = new PluginLifecycle(
            new PluginPackageReader(new Version(1, 3, 0)),
            store,
            TimeProvider.System);

        await nodeOne.InstallAsync(new MemoryStream(CreatePackage()));
        PluginRegistryEntry enabled = await nodeOne.EnableAsync("fsusblog.plugin.comment-guard");
        PluginRegistryEntry observed = Assert.Single(await nodeTwo.ListAsync());
        PluginRegistryEntry disabled = await nodeTwo.DisableAsync(observed.Manifest.Id);
        PluginRegistryEntry uninstalled = await nodeOne.UninstallAsync(disabled.Manifest.Id);

        Assert.True(enabled.Enabled);
        Assert.Equal(PluginInstallState.Enabled, enabled.InstallState);
        Assert.False(disabled.Enabled);
        Assert.Equal(PluginInstallState.Disabled, disabled.InstallState);
        Assert.False(uninstalled.Enabled);
        Assert.Equal(PluginInstallState.Uninstalled, uninstalled.InstallState);
        Assert.Empty(uninstalled.PackageBytes);
    }

    [Fact]
    public async Task EnableAsync_RawPermissionRequest_FailsClosed()
    {
        var store = new InMemoryPluginRegistryStore();
        var lifecycle = new PluginLifecycle(
            new PluginPackageReader(new Version(1, 3, 0)),
            store,
            TimeProvider.System);
        byte[] package = CreatePackage(manifestTransform: static json =>
            json.Replace("\"network\":false", "\"network\":true", StringComparison.Ordinal));
        PluginRegistryEntry installed = await lifecycle.InstallAsync(new MemoryStream(package));

        PluginLifecycleException exception = await Assert.ThrowsAsync<PluginLifecycleException>(
            () => lifecycle.EnableAsync(installed.Manifest.Id));

        Assert.Contains("cannot transition", exception.Message, StringComparison.Ordinal);
        PluginRegistryEntry unchanged = Assert.Single(await store.ListAsync());
        Assert.Equal(PluginInstallState.Installed, unchanged.InstallState);
        Assert.False(unchanged.Enabled);
    }

    [Fact]
    public void PluginManifestSchema_DeclaresClosedRequiredContract()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string schemaPath = Path.Combine(
            root,
            "src",
            "shared",
            "Contracts",
            "Plugins",
            "plugin-manifest.schema.json");

        using JsonDocument schema = JsonDocument.Parse(File.ReadAllBytes(schemaPath));
        JsonElement rootElement = schema.RootElement;
        Assert.False(rootElement.GetProperty("additionalProperties").GetBoolean());
        string[] required = rootElement.GetProperty("required")
            .EnumerateArray()
            .Select(static item => item.GetString()!)
            .ToArray();
        Assert.Contains("id", required);
        Assert.Contains("version", required);
        Assert.Contains("fsusblog", required);
        Assert.Contains("runtime", required);
        Assert.Contains("permissions", required);
        Assert.Contains("configSchema", required);
        Assert.Equal(
            [
                PluginLifecycleStage.Discover,
                PluginLifecycleStage.Verify,
                PluginLifecycleStage.Install,
                PluginLifecycleStage.ResolveDependencies,
                PluginLifecycleStage.ValidateManifest,
                PluginLifecycleStage.PrepareRuntime,
                PluginLifecycleStage.RegisterHooks,
                PluginLifecycleStage.Activate,
                PluginLifecycleStage.Execute,
                PluginLifecycleStage.Deactivate,
                PluginLifecycleStage.Uninstall
            ],
            Enum.GetValues<PluginLifecycleStage>());
    }

    [Fact]
    public void PluginRegistryMigration_PersistsClusterReadableStateAndPackage()
    {
        ISchemaMigrationDescriptor descriptor = PluginRegistryMigrationDefinitions.BuildMigration();
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal("20260724-post-plugin-registry", descriptor.MigrationId);
        Assert.True(descriptor.Transactional);
        Assert.Contains("plugin_registry", fingerprint, StringComparison.Ordinal);
        Assert.Contains("package_bytes bytea", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("manifest_json jsonb", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("install_state", fingerprint, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("version bigint", fingerprint, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void SchemaMigrationRegistry_ContainsPluginRegistryMigration()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == PluginRegistryMigrationDefinitions.MigrationId);

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
    }

    private static byte[] CreatePackage(
        string? checksumOverride = null,
        Func<string, string>? manifestTransform = null,
        (string Path, string Content)? extraEntry = null,
        string? configOverride = null)
    {
        const string Runtime = "return true";
        const string Config = """
            {"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":false,"properties":{"threshold":{"type":"integer"}}}
            """;
        string manifest = """
            {"id":"fsusblog.plugin.comment-guard","name":"Comment Guard","version":"1.0.0","fsusblog":">=1.3.0 <1.4.0","author":"example","description":"Comment audit rules","runtime":{"type":"lua","entry":"lua/main.lua"},"hooks":[{"name":"comment.beforeCreate","priority":100,"timeoutMs":30,"failPolicy":"fail-open"}],"capabilities":["comment.read","comment.moderate","plugin.storage.kv","plugin.log.write"],"permissions":{"network":false,"filesystem":false,"database":"none"},"configSchema":"config/schema.json"}
            """;
        manifest = manifestTransform?.Invoke(manifest) ?? manifest;
        var payload = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["manifest.json"] = manifest,
            ["lua/main.lua"] = Runtime,
            ["config/schema.json"] = configOverride ?? Config
        };
        if (extraEntry is { } item)
        {
            payload[item.Path] = item.Content;
        }

        var checksums = payload.ToDictionary(
            static item => item.Key,
            item => item.Key == "lua/main.lua" && checksumOverride is not null
                ? checksumOverride
                : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(item.Value))).ToLowerInvariant(),
            StringComparer.Ordinal);

        using var stream = new MemoryStream();
        using (var archive = new ZipArchive(stream, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string path, string content) in payload)
            {
                WriteEntry(archive, path, content);
            }
            WriteEntry(archive, "signature/checksums.json", JsonSerializer.Serialize(checksums));
            WriteEntry(archive, "signature/signature.sig", "unsigned-development-metadata");
        }
        return stream.ToArray();
    }

    private sealed class RejectingSignatureVerifier : IPluginPackageSignatureVerifier
    {
        public ValueTask<bool> VerifyAsync(
            PluginManifest manifest,
            ReadOnlyMemory<byte> checksumMetadata,
            ReadOnlyMemory<byte> signature,
            CancellationToken cancellationToken = default)
            => ValueTask.FromResult(false);
    }

    private static void WriteEntry(ZipArchive archive, string path, string content)
    {
        ZipArchiveEntry entry = archive.CreateEntry(path, CompressionLevel.NoCompression);
        using Stream stream = entry.Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }

    private sealed class InMemoryPluginRegistryStore : IPluginRegistryStore
    {
        private readonly Dictionary<string, PluginRegistryEntry> _entries = new(StringComparer.Ordinal);

        public Task<PluginRegistryEntry?> FindAsync(string pluginId, CancellationToken cancellationToken = default)
        {
            _entries.TryGetValue(pluginId, out PluginRegistryEntry? entry);
            return Task.FromResult(entry);
        }

        public Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<PluginRegistryEntry>>(
                _entries.Values.OrderBy(static item => item.Manifest.Id, StringComparer.Ordinal).ToArray());

        public Task<bool> TryInstallAsync(PluginRegistryEntry entry, CancellationToken cancellationToken = default)
            => Task.FromResult(_entries.TryAdd(entry.Manifest.Id, entry));

        public Task<PluginRegistryEntry?> TryUpdateAsync(
            PluginRegistryEntry entry,
            long expectedVersion,
            CancellationToken cancellationToken = default)
        {
            if (!_entries.TryGetValue(entry.Manifest.Id, out PluginRegistryEntry? existing)
                || existing.Version != expectedVersion)
            {
                return Task.FromResult<PluginRegistryEntry?>(null);
            }

            PluginRegistryEntry updated = entry with
            {
                Version = expectedVersion + 1
            };
            _entries[entry.Manifest.Id] = updated;
            return Task.FromResult<PluginRegistryEntry?>(updated);
        }
    }
}
