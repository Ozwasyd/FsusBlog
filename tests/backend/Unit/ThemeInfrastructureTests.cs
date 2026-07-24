using System.IO.Compression;
using System.Text;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Themes;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ThemeInfrastructureTests
{
    [Fact]
    public void Validate_AcceptsMinimumPackageAndTracksContentHashes()
    {
        using MemoryStream package = CreatePackage();
        var validator = new ThemePackageValidator();

        ValidatedThemePackage validated = validator.Validate(package, new Version(1, 3, 0));

        Assert.Equal("fsusblog.theme.minimal-ink", validated.Manifest.Id);
        Assert.Equal("1.0.0", validated.Manifest.Version);
        Assert.Equal(5, validated.Entries.Count);
        Assert.All(validated.Entries, static entry =>
        {
            Assert.Matches("^[0-9a-f]{64}$", entry.ContentHash);
            Assert.True(entry.SizeBytes > 0);
        });
        Assert.Matches("^[0-9a-f]{64}$", validated.PackageHash);
        Assert.Equal(
            validated.Entries.Single(static entry => entry.Path == "assets/preview.png").ContentHash,
            validated.Assets["preview"].ContentHash);
    }

    [Fact]
    public void Validate_RejectsMissingRequiredFile()
    {
        using MemoryStream package = CreatePackage(entriesToOmit: ["styles/theme.css"]);
        var validator = new ThemePackageValidator();

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => validator.Validate(package, new Version(1, 3, 0)));

        Assert.Equal("theme_package_required_file_missing", exception.ErrorCode);
        Assert.Contains("styles/theme.css", exception.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("../theme.css")]
    [InlineData("/styles/theme.css")]
    [InlineData("styles\\theme.css")]
    public void Validate_RejectsNonCanonicalEntryPaths(string unsafePath)
    {
        using MemoryStream package = CreatePackage(extraEntries: new Dictionary<string, byte[]>
        {
            [unsafePath] = Encoding.UTF8.GetBytes("unsafe")
        });
        var validator = new ThemePackageValidator();

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => validator.Validate(package, new Version(1, 3, 0)));

        Assert.Equal("theme_package_path_invalid", exception.ErrorCode);
    }

    [Fact]
    public void Validate_RejectsDuplicateCanonicalEntries()
    {
        using var package = new MemoryStream();
        using (var archive = new ZipArchive(package, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteEntry(archive, "manifest.json", ManifestJson());
            WriteEntry(archive, "manifest.json", ManifestJson());
        }
        package.Position = 0;
        var validator = new ThemePackageValidator();

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => validator.Validate(package, new Version(1, 3, 0)));

        Assert.Equal("theme_package_entry_duplicate", exception.ErrorCode);
    }

    [Fact]
    public void Validate_RejectsIncompatibleFsusBlogVersion()
    {
        using MemoryStream package = CreatePackage();
        var validator = new ThemePackageValidator();

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => validator.Validate(package, new Version(1, 4, 0)));

        Assert.Equal("theme_manifest_version_incompatible", exception.ErrorCode);
    }

    [Fact]
    public void Validate_RejectsExecutablePermissions()
    {
        using MemoryStream package = CreatePackage(manifest: ManifestJson(scriptPermission: true));
        var validator = new ThemePackageValidator();

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => validator.Validate(package, new Version(1, 3, 0)));

        Assert.Equal("theme_manifest_permission_denied", exception.ErrorCode);
    }

    [Fact]
    public void Validate_RejectsUnknownManifestMembers()
    {
        string manifest = ManifestJson().Replace(
            "\"name\": \"Minimal Ink\",",
            "\"name\": \"Minimal Ink\", \"unexpected\": true,",
            StringComparison.Ordinal);
        using MemoryStream package = CreatePackage(manifest: manifest);
        var validator = new ThemePackageValidator();

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => validator.Validate(package, new Version(1, 3, 0)));

        Assert.Equal("theme_manifest_invalid", exception.ErrorCode);
    }

    [Fact]
    public void ValidateConfig_EnforcesDeclaredPropertiesAndTypes()
    {
        using MemoryStream package = CreatePackage();
        var validator = new ThemePackageValidator();
        ValidatedThemePackage validated = validator.Validate(package, new Version(1, 3, 0));

        validator.ValidateConfig(validated, """{"fontScale":1.125,"showAuthor":true}""");

        ThemePackageException unknown = Assert.Throws<ThemePackageException>(
            () => validator.ValidateConfig(validated, """{"unknown":"value"}"""));
        ThemePackageException wrongType = Assert.Throws<ThemePackageException>(
            () => validator.ValidateConfig(validated, """{"fontScale":"large"}"""));
        Assert.Equal("theme_config_property_unknown", unknown.ErrorCode);
        Assert.Equal("theme_config_type_invalid", wrongType.ErrorCode);
    }

    [Fact]
    public async Task LocalPackageStore_AtomicallyPersistsAndDeletesValidatedContent()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-theme-store-{Guid.NewGuid():N}");
        try
        {
            using MemoryStream package = CreatePackage(extraEntries: new Dictionary<string, byte[]>
            {
                ["archive.fstheme"] = Encoding.UTF8.GetBytes("theme-owned entry")
            });
            ValidatedThemePackage validated = new ThemePackageValidator().Validate(
                package,
                new Version(1, 3, 0));
            var store = new LocalThemePackageStore(root);

            ThemePackageStoreReceipt first = await store.StoreAsync(validated, CancellationToken.None);
            ThemePackageStoreReceipt second = await store.StoreAsync(validated, CancellationToken.None);

            Assert.True(first.Created);
            Assert.False(second.Created);
            Assert.Equal(first.Location, second.Location);
            Assert.True(File.Exists(Path.Combine(first.Location, "archive.fstheme")));
            Assert.True(File.Exists(Path.Combine(first.Location, "content", "styles", "tokens.css")));
            Assert.True(File.Exists(Path.Combine(first.Location, "content", "assets", "preview.png")));
            Assert.Equal(
                "theme-owned entry",
                await File.ReadAllTextAsync(
                    Path.Combine(first.Location, "content", "archive.fstheme")));
            Assert.Empty(Directory.EnumerateDirectories(
                Path.Combine(root, validated.Manifest.Id),
                ".staging-*"));

            await store.DeleteAsync(first.Location, CancellationToken.None);
            Assert.False(Directory.Exists(first.Location));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public async Task LocalPackageStore_RejectsBytesThatChangedAfterValidation()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-theme-store-{Guid.NewGuid():N}");
        try
        {
            using MemoryStream package = CreatePackage();
            ValidatedThemePackage validated = new ThemePackageValidator().Validate(
                package,
                new Version(1, 3, 0));
            byte[] changedBytes = validated.PackageBytes.ToArray();
            changedBytes[^1] ^= 0xff;
            var store = new LocalThemePackageStore(root);

            ThemePackageException exception = await Assert.ThrowsAsync<ThemePackageException>(
                () => store.StoreAsync(
                    validated with
                    {
                        PackageBytes = changedBytes
                    },
                    CancellationToken.None));

            Assert.Equal("theme_package_store_hash_mismatch", exception.ErrorCode);
            Assert.False(Directory.Exists(root));
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Fact]
    public async Task InstallFailure_DoesNotChangeExistingActivation()
    {
        var registry = new InMemoryThemeRegistry();
        var lifecycle = new ThemeLifecycleService(
            new ThemePackageValidator(),
            registry,
            new Version(1, 3, 0),
            TimeProvider.System);
        using MemoryStream activePackage = CreatePackage();
        await lifecycle.InstallAsync(activePackage, CancellationToken.None);
        await lifecycle.EnableAsync(
            ThemeActivationScope.Public,
            "fsusblog.theme.minimal-ink",
            CancellationToken.None);
        ThemeActivationSnapshot? before = await registry.GetActivationAsync(
            ThemeActivationScope.Public,
            CancellationToken.None);
        Assert.NotNull(before);
        using MemoryStream invalidPackage = CreatePackage(entriesToOmit: ["manifest.json"]);

        await Assert.ThrowsAsync<ThemePackageException>(
            () => lifecycle.InstallAsync(invalidPackage, CancellationToken.None));

        ThemeActivationSnapshot? after = await registry.GetActivationAsync(
            ThemeActivationScope.Public,
            CancellationToken.None);
        Assert.NotNull(after);
        Assert.Equal(before, after);
    }

    [Fact]
    public async Task Uninstall_RefusesActiveThemeUntilReplacementIsSelected()
    {
        var registry = new InMemoryThemeRegistry();
        var lifecycle = new ThemeLifecycleService(
            new ThemePackageValidator(),
            registry,
            new Version(1, 3, 0),
            TimeProvider.System);
        using MemoryStream firstPackage = CreatePackage();
        await lifecycle.InstallAsync(firstPackage, CancellationToken.None);
        await lifecycle.EnableAsync(
            ThemeActivationScope.SiteWide,
            "fsusblog.theme.minimal-ink",
            CancellationToken.None);

        ThemeLifecycleException activeException = await Assert.ThrowsAsync<ThemeLifecycleException>(
            () => lifecycle.UninstallAsync(
                "fsusblog.theme.minimal-ink",
                replacementThemeId: null,
                CancellationToken.None));

        Assert.Equal("theme_uninstall_active_replacement_required", activeException.ErrorCode);
        ThemeRegistrySnapshot? active = await registry.GetThemeAsync(
            "fsusblog.theme.minimal-ink",
            CancellationToken.None);
        Assert.NotNull(active);
        Assert.Equal(ThemeInstallState.Enabled, active.InstallState);

        using MemoryStream replacementPackage = CreatePackage(
            manifest: ManifestJson(
                id: "fsusblog.theme.paper",
                name: "Paper",
                version: "2.0.0"));
        await lifecycle.InstallAsync(replacementPackage, CancellationToken.None);
        await lifecycle.UninstallAsync(
            "fsusblog.theme.minimal-ink",
            "fsusblog.theme.paper",
            CancellationToken.None);

        ThemeActivationSnapshot? replacementActivation = await registry.GetActivationAsync(
            ThemeActivationScope.SiteWide,
            CancellationToken.None);
        Assert.NotNull(replacementActivation);
        Assert.Equal("fsusblog.theme.paper", replacementActivation.ActiveThemeId);
        ThemeRegistrySnapshot? uninstalled = await registry.GetThemeAsync(
            "fsusblog.theme.minimal-ink",
            CancellationToken.None);
        Assert.NotNull(uninstalled);
        Assert.Equal(ThemeInstallState.Uninstalled, uninstalled.InstallState);

        await lifecycle.UninstallAsync(
            "fsusblog.theme.minimal-ink",
            replacementThemeId: null,
            CancellationToken.None);
    }

    [Fact]
    public async Task Disable_LastScopeMarksThemeDisabled()
    {
        var registry = new InMemoryThemeRegistry();
        var lifecycle = new ThemeLifecycleService(
            new ThemePackageValidator(),
            registry,
            new Version(1, 3, 0),
            TimeProvider.System);
        using MemoryStream package = CreatePackage();
        await lifecycle.InstallAsync(package, CancellationToken.None);
        await lifecycle.EnableAsync(
            ThemeActivationScope.Console,
            "fsusblog.theme.minimal-ink",
            CancellationToken.None);

        await lifecycle.DisableAsync(ThemeActivationScope.Console, CancellationToken.None);

        Assert.Null(await registry.GetActivationAsync(
            ThemeActivationScope.Console,
            CancellationToken.None));
        ThemeRegistrySnapshot? disabled = await registry.GetThemeAsync(
            "fsusblog.theme.minimal-ink",
            CancellationToken.None);
        Assert.NotNull(disabled);
        Assert.Equal(ThemeInstallState.Disabled, disabled.InstallState);
        Assert.False(disabled.Enabled);
    }

    [Fact]
    public async Task SaveConfig_RequiresSchemaValidityAndMonotonicVersion()
    {
        var registry = new InMemoryThemeRegistry();
        var lifecycle = new ThemeLifecycleService(
            new ThemePackageValidator(),
            registry,
            new Version(1, 3, 0),
            TimeProvider.System);
        using MemoryStream package = CreatePackage();
        await lifecycle.InstallAsync(package, CancellationToken.None);

        await lifecycle.SaveConfigAsync(
            "fsusblog.theme.minimal-ink",
            """{"fontScale":1.25}""",
            version: 2,
            CancellationToken.None);

        ThemeLifecycleException stale = await Assert.ThrowsAsync<ThemeLifecycleException>(
            () => lifecycle.SaveConfigAsync(
                "fsusblog.theme.minimal-ink",
                """{"fontScale":1.5}""",
                version: 1,
                CancellationToken.None));
        ThemePackageException invalid = await Assert.ThrowsAsync<ThemePackageException>(
            () => lifecycle.SaveConfigAsync(
                "fsusblog.theme.minimal-ink",
                """{"fontScale":"large"}""",
                version: 3,
                CancellationToken.None));
        Assert.Equal("theme_config_version_conflict", stale.ErrorCode);
        Assert.Equal("theme_config_type_invalid", invalid.ErrorCode);
    }

    [Fact]
    public void RuntimeServices_RegisterDurableThemeInfrastructure()
    {
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);

        services.AddFsusRuntimeInfrastructureServices(new ConfigurationBuilder().Build());

        ServiceDescriptor validator = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(ThemePackageValidator));
        ServiceDescriptor tokenCompiler = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(ThemeTokenCompiler));
        ServiceDescriptor registry = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IThemeRegistry));
        ServiceDescriptor packageStore = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IThemePackageStore));
        ServiceDescriptor lifecycle = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(ThemeLifecycleService));
        Assert.Equal(ServiceLifetime.Singleton, validator.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, tokenCompiler.Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, registry.Lifetime);
        Assert.Equal(typeof(PostgresThemeRegistry), registry.ImplementationType);
        Assert.Equal(ServiceLifetime.Singleton, packageStore.Lifetime);
        Assert.IsType<LocalThemePackageStore>(packageStore.ImplementationInstance);
        Assert.Equal(ServiceLifetime.Scoped, lifecycle.Lifetime);
    }

    [Fact]
    public void Migration_DefinesRegistryConfigActivationAndAssetTables()
    {
        ISchemaMigrationDescriptor descriptor = Assert.Single(
            new SchemaMigrationRegistry().GetDescriptors(),
            static item => item.MigrationId == "20260724-post-theme-registry");
        string fingerprint = string.Join('\n', descriptor.Steps.Select(static step => step.Fingerprint));

        Assert.Equal(SchemaMigrationPhase.PostCodeFirst, descriptor.Phase);
        Assert.Contains("CREATE TABLE IF NOT EXISTS theme_registry", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS theme_config", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS theme_activation", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS theme_asset", fingerprint, StringComparison.Ordinal);
        Assert.Contains("content_hash varchar(64) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("package_location varchar(1024) NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("UNIQUE(theme_id, asset_key)", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CHECK (install_state IN", fingerprint, StringComparison.Ordinal);
    }

    private static MemoryStream CreatePackage(
        string? manifest = null,
        IReadOnlyCollection<string>? entriesToOmit = null,
        IReadOnlyDictionary<string, byte[]>? extraEntries = null)
    {
        var package = new MemoryStream();
        using (var archive = new ZipArchive(package, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entries = new Dictionary<string, byte[]>(StringComparer.Ordinal)
            {
                ["manifest.json"] = Encoding.UTF8.GetBytes(manifest ?? ManifestJson()),
                ["styles/tokens.css"] = Encoding.UTF8.GetBytes(":root { --paper: #fff; }"),
                ["styles/theme.css"] = Encoding.UTF8.GetBytes("body { background: var(--paper); }"),
                ["assets/preview.png"] = [0x89, 0x50, 0x4e, 0x47],
                ["config/schema.json"] = Encoding.UTF8.GetBytes(
                    """{"type":"object","additionalProperties":false,"properties":{"fontScale":{"type":"number"},"showAuthor":{"type":"boolean"}}}""")
            };
            foreach ((string path, byte[] content) in entries)
            {
                if (entriesToOmit?.Contains(path) != true)
                {
                    WriteEntry(archive, path, content);
                }
            }
            if (extraEntries is not null)
            {
                foreach ((string path, byte[] content) in extraEntries)
                {
                    WriteEntry(archive, path, content);
                }
            }
        }
        package.Position = 0;
        return package;
    }

    private static string ManifestJson(
        string id = "fsusblog.theme.minimal-ink",
        string name = "Minimal Ink",
        string version = "1.0.0",
        bool scriptPermission = false)
        => $$"""
            {
                "id": "{{id}}",
                "name": "{{name}}",
                "version": "{{version}}",
                "fsusblog": ">=1.3.0 <1.4.0",
                "author": "example",
                "description": "A reading theme",
                "type": "theme",
                "entry": {
                    "tokens": "styles/tokens.css",
                    "theme": "styles/theme.css"
                },
                "modes": ["light", "dark"],
                "supports": {
                    "public": true,
                    "admin": false,
                    "console": false,
                    "highContrast": true,
                    "reducedMotion": true,
                    "rtl": false
                },
                "assets": {
                    "preview": "assets/preview.png"
                },
                "configSchema": "config/schema.json",
                "permissions": {
                    "script": {{scriptPermission.ToString().ToLowerInvariant()}},
                    "network": false,
                    "filesystem": false
                },
                "budgets": {
                    "cssBytes": 65536,
                    "assetBytes": 524288,
                    "maxSelectors": 512
                }
            }
            """;

    private static void WriteEntry(ZipArchive archive, string path, string content)
        => WriteEntry(archive, path, Encoding.UTF8.GetBytes(content));

    private static void WriteEntry(ZipArchive archive, string path, byte[] content)
    {
        ZipArchiveEntry entry = archive.CreateEntry(path);
        using Stream stream = entry.Open();
        stream.Write(content);
    }
}
