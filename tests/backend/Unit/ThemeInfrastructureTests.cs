using System.IO.Compression;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
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
        Assert.NotNull(validated.CssSafetyEvidence);
        Assert.Equal("ok", validated.CssSafetyEvidence.Status);
        Assert.Empty(validated.CssSafetyEvidence.Violations);
        string evidenceJson = JsonSerializer.Serialize(
            validated.CssSafetyEvidence,
            ThemeJsonSerializerContext.Default.ThemeCssSafetyEvidence);
        Assert.Contains(
            """"schema":"fsusblog.theme.css-safety.v1"""",
            evidenceJson,
            StringComparison.Ordinal);
        Assert.Contains(""""maxSelectorDepth":2"""", evidenceJson, StringComparison.Ordinal);
    }

    [Fact]
    public void Validate_RejectsUnsafeSelectorsRemoteResourcesAndMotionWithMachineEvidence()
    {
        using MemoryStream package = CreatePackage(entryOverrides: new Dictionary<string, byte[]>
        {
            ["styles/theme.css"] = Encoding.UTF8.GetBytes(
                """
                body, .el-dialog__body {
                    background: url("https://tracker.invalid/theme.png");
                    position: fixed;
                    inset: 0;
                    animation: pulse 2s infinite;
                    transition: width 2s;
                    z-index: 999999;
                    backdrop-filter: blur(40px) !important;
                }
                """)
        });

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => new ThemePackageValidator().Validate(package, new Version(1, 3, 0)));

        Assert.Equal("theme_css_safety_blocked", exception.ErrorCode);
        ThemeCssSafetyEvidence evidence = Assert.IsType<ThemeCssSafetyEvidence>(
            exception.CssSafetyEvidence);
        Assert.Equal(ThemeCssSafetyScanner.EvidenceSchema, evidence.Schema);
        Assert.Equal("blocked", evidence.Status);
        Assert.Contains(evidence.Violations, static item => item.Code == "selector_scope_denied");
        Assert.Contains(evidence.Violations, static item => item.Code == "element_plus_internal_selector_denied");
        Assert.Contains(evidence.Violations, static item => item.Code == "resource_url_denied");
        Assert.Contains(evidence.Violations, static item => item.Code == "unbounded_animation_denied");
        Assert.Contains(evidence.Violations, static item => item.Code == "layout_transition_denied");
        Assert.Contains(evidence.Violations, static item => item.Code == "full_viewport_fixed_overlay_denied");
        Assert.Contains(evidence.Violations, static item => item.Code == "z_index_budget_exceeded");
        Assert.Contains(evidence.Violations, static item => item.Code == "filter_budget_exceeded");
        Assert.Contains(evidence.Violations, static item => item.Code == "motion_duration_exceeded");
    }

    [Fact]
    public void Validate_EnforcesPreviewSelectorDepthAndImportantBudgets()
    {
        string manifest = ManifestJson()
            .Replace("\"previewBytes\": 262144", "\"previewBytes\": 3", StringComparison.Ordinal)
            .Replace("\"maxSelectorDepth\": 4", "\"maxSelectorDepth\": 2", StringComparison.Ordinal)
            .Replace("\"maxImportant\": 8", "\"maxImportant\": 0", StringComparison.Ordinal);
        using MemoryStream package = CreatePackage(
            manifest: manifest,
            entryOverrides: new Dictionary<string, byte[]>
            {
                ["styles/theme.css"] = Encoding.UTF8.GetBytes(
                    """
                    [data-theme="fsusblog.theme.minimal-ink"] .fsus-prose .note strong {
                        color: var(--fsus-color-text-primary) !important;
                    }
                    """)
            });

        ThemePackageException exception = Assert.Throws<ThemePackageException>(
            () => new ThemePackageValidator().Validate(package, new Version(1, 3, 0)));

        ThemeCssSafetyEvidence evidence = Assert.IsType<ThemeCssSafetyEvidence>(
            exception.CssSafetyEvidence);
        Assert.Contains(evidence.Violations, static item => item.Code == "preview_bytes_exceeded");
        Assert.Contains(evidence.Violations, static item => item.Code == "selector_depth_exceeded");
        Assert.Contains(evidence.Violations, static item => item.Code == "important_count_exceeded");
    }

    [Fact]
    public void Validate_EnforcesSelectorCountAndFailsClosedOnMalformedCss()
    {
        string selectorFlood = string.Join(
            ",",
            Enumerable.Range(0, 513).Select(
                static index =>
                    $"[data-theme=\"fsusblog.theme.minimal-ink\"] .fsus-theme-scope .item-{index}"));
        using MemoryStream overSelectorBudget = CreatePackage(entryOverrides: new Dictionary<string, byte[]>
        {
            ["styles/theme.css"] = Encoding.UTF8.GetBytes($"{selectorFlood} {{ color: red; }}")
        });
        using MemoryStream malformed = CreatePackage(entryOverrides: new Dictionary<string, byte[]>
        {
            ["styles/theme.css"] = Encoding.UTF8.GetBytes(
                """[data-theme="fsusblog.theme.minimal-ink"] .fsus-theme-scope { color: red;""")
        });

        ThemePackageException selectorException = Assert.Throws<ThemePackageException>(
            () => new ThemePackageValidator().Validate(
                overSelectorBudget,
                new Version(1, 3, 0)));
        ThemePackageException malformedException = Assert.Throws<ThemePackageException>(
            () => new ThemePackageValidator().Validate(
                malformed,
                new Version(1, 3, 0)));

        Assert.Contains(
            Assert.IsType<ThemeCssSafetyEvidence>(selectorException.CssSafetyEvidence).Violations,
            static item => item.Code == "selector_count_exceeded");
        Assert.Contains(
            Assert.IsType<ThemeCssSafetyEvidence>(malformedException.CssSafetyEvidence).Violations,
            static item => item.Code == "css_syntax_unbalanced");
    }

    [Fact]
    public void Validate_AllowsOnlyDeclaredRelativePackageAssetUrls()
    {
        using MemoryStream package = CreatePackage(
            manifest: ManifestJson().Replace(
                "\"maxImportant\": 8",
                "\"maxImportant\": 0",
                StringComparison.Ordinal),
            entryOverrides: new Dictionary<string, byte[]>
            {
                ["styles/theme.css"] = Encoding.UTF8.GetBytes(
                    """
                    [data-theme="fsusblog.theme.minimal-ink"] .fsus-theme-scope {
                        background-image: url("../assets/preview.png");
                    }
                    """)
            });

        ValidatedThemePackage validated = new ThemePackageValidator().Validate(
            package,
            new Version(1, 3, 0));

        Assert.Equal("ok", validated.CssSafetyEvidence?.Status);
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
    public async Task Enable_RescansStoredPackageAndPreservesCurrentActivationOnFailure()
    {
        string root = Path.Combine(
            Path.GetTempPath(),
            $"fsusblog-theme-activation-safety-{Guid.NewGuid():N}");
        try
        {
            var registry = new InMemoryThemeRegistry();
            var store = new LocalThemePackageStore(root);
            var lifecycle = new ThemeLifecycleService(
                new ThemePackageValidator(),
                registry,
                new Version(1, 3, 0),
                TimeProvider.System,
                store);
            using MemoryStream package = CreatePackage();
            ThemeRegistrySnapshot installed = await lifecycle.InstallAsync(
                package,
                CancellationToken.None);
            using MemoryStream unsafePackage = CreatePackage(entryOverrides: new Dictionary<string, byte[]>
            {
                ["styles/theme.css"] = Encoding.UTF8.GetBytes(
                    """body { background: url("javascript:alert(1)"); }""")
            });
            await File.WriteAllBytesAsync(
                Path.Combine(installed.PackageLocation, "archive.fstheme"),
                unsafePackage.ToArray());

            ThemeLifecycleException exception = await Assert.ThrowsAsync<ThemeLifecycleException>(
                () => lifecycle.EnableAsync(
                    ThemeActivationScope.Public,
                    installed.Manifest.Id,
                    CancellationToken.None));

            Assert.Equal("theme_activation_safety_scan_failed", exception.ErrorCode);
            Assert.Null(await registry.GetActivationAsync(
                ThemeActivationScope.Public,
                CancellationToken.None));
            ThemeRegistrySnapshot? unchanged = await registry.GetThemeAsync(
                installed.Manifest.Id,
                CancellationToken.None);
            Assert.NotNull(unchanged);
            Assert.Equal(ThemeInstallState.Installed, unchanged.InstallState);
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
        ServiceDescriptor cssSafetyScanner = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(ThemeCssSafetyScanner));
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
        ServiceDescriptor activationRuntime = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(ThemeActivationRuntimeService));
        ServiceDescriptor activationEffects = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IThemeActivationEffects));
        ServiceDescriptor runtimeState = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(ThemeRuntimeState));
        Assert.Equal(ServiceLifetime.Singleton, validator.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, cssSafetyScanner.Lifetime);
        Assert.Equal(ServiceLifetime.Singleton, tokenCompiler.Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, registry.Lifetime);
        Assert.Equal(typeof(PostgresThemeRegistry), registry.ImplementationType);
        Assert.Equal(ServiceLifetime.Singleton, packageStore.Lifetime);
        Assert.IsType<LocalThemePackageStore>(packageStore.ImplementationInstance);
        Assert.Equal(ServiceLifetime.Scoped, lifecycle.Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, activationRuntime.Lifetime);
        Assert.Equal(ServiceLifetime.Scoped, activationEffects.Lifetime);
        Assert.Equal(typeof(ThemeActivationEffects), activationEffects.ImplementationType);
        Assert.Equal(ServiceLifetime.Singleton, runtimeState.Lifetime);
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

    [Fact]
    public async Task ThemeRuntime_PreviewIsIsolatedAndApplyPublishesSharedAssetVersion()
    {
        var registry = new InMemoryThemeRegistry();
        var store = new InMemoryThemePackageStore();
        var effects = new RecordingThemeEffects();
        ThemeLifecycleService lifecycle = CreateLifecycle(registry, store);
        ThemeActivationRuntimeService runtime = CreateRuntime(registry, store, effects);
        using MemoryStream publicPackage = CreatePackage();
        using MemoryStream previewPackage = CreatePackage(
            manifest: ManifestJson(id: "fsusblog.theme.paper", name: "Paper"));
        ThemeRegistrySnapshot publicTheme = await lifecycle.InstallAsync(
            publicPackage,
            CancellationToken.None);
        ThemeRegistrySnapshot previewTheme = await lifecycle.InstallAsync(
            previewPackage,
            CancellationToken.None);

        ThemeActivationHistorySnapshot applied = await runtime.ApplyAsync(
            ThemeActivationScope.Public,
            publicTheme.Manifest.Id,
            "dark",
            "admin:42",
            CancellationToken.None);
        ThemeActivationHistorySnapshot previewed = await runtime.PreviewAsync(
            ThemeActivationScope.UserPreview(42),
            previewTheme.Manifest.Id,
            "light",
            "admin:42",
            CancellationToken.None);

        ThemeActivationSnapshot? publicActivation = await registry.GetActivationAsync(
            ThemeActivationScope.Public,
            CancellationToken.None);
        ThemeActivationSnapshot? previewActivation = await registry.GetActivationAsync(
            ThemeActivationScope.UserPreview(42),
            CancellationToken.None);
        Assert.Equal(publicTheme.Manifest.Id, publicActivation?.ActiveThemeId);
        Assert.Equal(previewTheme.Manifest.Id, previewActivation?.ActiveThemeId);
        Assert.Equal(publicTheme.PackageHash, publicActivation?.AssetVersion);
        Assert.Equal(previewTheme.PackageHash, previewActivation?.AssetVersion);
        Assert.Equal([true, false], effects.Invalidations);
        Assert.Contains(""""status":"applied"""", applied.EvidenceJson, StringComparison.Ordinal);
        Assert.Contains("user-preview:42", previewed.EvidenceJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ThemeRuntime_RollbackRestoresThemeAssetConfigAndModeAtomically()
    {
        var registry = new InMemoryThemeRegistry();
        var store = new InMemoryThemePackageStore();
        ThemeLifecycleService lifecycle = CreateLifecycle(registry, store);
        ThemeActivationRuntimeService runtime = CreateRuntime(registry, store);
        using MemoryStream firstPackage = CreatePackage();
        using MemoryStream secondPackage = CreatePackage(
            manifest: ManifestJson(id: "fsusblog.theme.paper", name: "Paper"));
        ThemeRegistrySnapshot first = await lifecycle.InstallAsync(firstPackage, CancellationToken.None);
        ThemeRegistrySnapshot second = await lifecycle.InstallAsync(secondPackage, CancellationToken.None);
        await lifecycle.SaveConfigAsync(
            first.Manifest.Id,
            """{"fontScale":1.1}""",
            1,
            CancellationToken.None);
        await lifecycle.SaveConfigAsync(
            second.Manifest.Id,
            """{"fontScale":1.2}""",
            2,
            CancellationToken.None);
        await runtime.ApplyAsync(
            ThemeActivationScope.SiteWide,
            first.Manifest.Id,
            "dark",
            "admin:1",
            CancellationToken.None);
        ThemeActivationHistorySnapshot secondActivation = await runtime.ApplyAsync(
            ThemeActivationScope.SiteWide,
            second.Manifest.Id,
            "light",
            "admin:1",
            CancellationToken.None);

        ThemeActivationHistorySnapshot rollback = await runtime.RollbackAsync(
            ThemeActivationScope.SiteWide,
            secondActivation.Id,
            "admin:1",
            "post-activation smoke failed",
            CancellationToken.None);

        ThemeActivationSnapshot? restored = await registry.GetActivationAsync(
            ThemeActivationScope.SiteWide,
            CancellationToken.None);
        Assert.Equal(first.Manifest.Id, restored?.ActiveThemeId);
        Assert.Equal(first.PackageHash, restored?.AssetVersion);
        Assert.Equal(1, restored?.ConfigVersion);
        Assert.Equal("dark", restored?.Mode);
        Assert.Equal(ThemeActivationStatus.RolledBack, rollback.Status);
        Assert.Equal(second.Manifest.Id, rollback.PreviousThemeId);
        Assert.Contains("post-activation smoke failed", rollback.EvidenceJson, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ThemeRuntime_PublishFailureAutomaticallyRollsBackPreviousActivation()
    {
        var registry = new InMemoryThemeRegistry();
        var store = new InMemoryThemePackageStore();
        var effects = new RecordingThemeEffects();
        ThemeLifecycleService lifecycle = CreateLifecycle(registry, store);
        ThemeActivationRuntimeService runtime = CreateRuntime(registry, store, effects);
        using MemoryStream firstPackage = CreatePackage();
        using MemoryStream secondPackage = CreatePackage(
            manifest: ManifestJson(id: "fsusblog.theme.paper", name: "Paper"));
        ThemeRegistrySnapshot first = await lifecycle.InstallAsync(firstPackage, CancellationToken.None);
        ThemeRegistrySnapshot second = await lifecycle.InstallAsync(secondPackage, CancellationToken.None);
        await runtime.ApplyAsync(
            ThemeActivationScope.Public,
            first.Manifest.Id,
            "auto",
            "admin:1",
            CancellationToken.None);
        effects.Fail = true;

        ThemeLifecycleException failure = await Assert.ThrowsAsync<ThemeLifecycleException>(
            () => runtime.ApplyAsync(
                ThemeActivationScope.Public,
                second.Manifest.Id,
                "dark",
                "admin:1",
                CancellationToken.None));

        Assert.Equal("theme_activation_publish_failed", failure.ErrorCode);
        ThemeActivationSnapshot? restored = await registry.GetActivationAsync(
            ThemeActivationScope.Public,
            CancellationToken.None);
        Assert.Equal(first.Manifest.Id, restored?.ActiveThemeId);
        IReadOnlyList<ThemeActivationHistorySnapshot> history = await runtime.GetHistoryAsync(
            ThemeActivationScope.Public,
            10,
            CancellationToken.None);
        Assert.Contains(
            history,
            static item => item.Status == ThemeActivationStatus.RolledBack
                && item.FailureReason?.Contains("theme_activation_publish_failed", StringComparison.Ordinal) == true);
    }

    [Fact]
    public async Task ThemeRuntime_CssFailureRollsBackOnlyMatchingActivationAndResetUsesDefault()
    {
        var registry = new InMemoryThemeRegistry();
        var store = new InMemoryThemePackageStore();
        ThemeLifecycleService lifecycle = CreateLifecycle(registry, store);
        ThemeActivationRuntimeService runtime = CreateRuntime(registry, store);
        using MemoryStream package = CreatePackage();
        ThemeRegistrySnapshot theme = await lifecycle.InstallAsync(package, CancellationToken.None);
        ThemeActivationHistorySnapshot activation = await runtime.ApplyAsync(
            ThemeActivationScope.Admin,
            theme.Manifest.Id,
            "auto",
            "admin:7",
            CancellationToken.None);

        ThemeLifecycleException stale = await Assert.ThrowsAsync<ThemeLifecycleException>(
            () => runtime.ReportRuntimeCssLoadFailureAsync(
                new ThemeRuntimeCssFailure(
                    Guid.NewGuid(),
                    ThemeActivationScope.Admin,
                    theme.Manifest.Id,
                    theme.PackageHash,
                    "theme_asset_stylesheet_load_failed",
                    "stylesheet error event",
                    "admin:7"),
                CancellationToken.None));
        Assert.Equal("theme_runtime_failure_stale", stale.ErrorCode);

        ThemeActivationHistorySnapshot rollback = await runtime.ReportRuntimeCssLoadFailureAsync(
            new ThemeRuntimeCssFailure(
                activation.Id,
                ThemeActivationScope.Admin,
                theme.Manifest.Id,
                theme.PackageHash,
                "theme_asset_stylesheet_load_failed",
                "stylesheet error event",
                "admin:7"),
            CancellationToken.None);
        Assert.Equal(ThemeActivationStatus.RolledBack, rollback.Status);
        Assert.Null(await registry.GetActivationAsync(
            ThemeActivationScope.Admin,
            CancellationToken.None));

        ThemeActivationHistorySnapshot reset = await runtime.ResetToDefaultAsync(
            ThemeActivationScope.Public,
            "admin:7",
            "hot disable",
            CancellationToken.None);
        Assert.Equal(ThemeActivationStatus.ResetToDefault, reset.Status);
        Assert.Null(reset.ThemeId);
    }

    [Fact]
    public void ThemeActivationRuntimeMigration_DeclaresHistoryAndVersionColumns()
    {
        ISchemaMigrationDescriptor migration = ThemeActivationRuntimeMigrationDefinitions.BuildMigration();
        string fingerprint = string.Join('\n', migration.Steps.Select(static step => step.Fingerprint));

        Assert.Equal("20260724-post-theme-runtime", migration.MigrationId);
        Assert.Contains("theme_activation.activation_id:varchar(36) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("theme_activation.asset_version:varchar(64) NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("CREATE TABLE IF NOT EXISTS theme_activation_history", fingerprint, StringComparison.Ordinal);
        Assert.Contains("evidence_json jsonb NOT NULL", fingerprint, StringComparison.Ordinal);
        Assert.Contains("reset_to_default", fingerprint, StringComparison.Ordinal);
    }

    private static ThemeLifecycleService CreateLifecycle(
        IThemeRegistry registry,
        IThemePackageStore store)
        => new(
            new ThemePackageValidator(),
            registry,
            new Version(1, 3, 0),
            TimeProvider.System,
            store);

    private static ThemeActivationRuntimeService CreateRuntime(
        IThemeRegistry registry,
        IThemePackageStore store,
        IThemeActivationEffects? effects = null)
        => new(
            new ThemePackageValidator(),
            registry,
            new Version(1, 3, 0),
            TimeProvider.System,
            store,
            effects);

    private static MemoryStream CreatePackage(
        string? manifest = null,
        IReadOnlyCollection<string>? entriesToOmit = null,
        IReadOnlyDictionary<string, byte[]>? extraEntries = null,
        IReadOnlyDictionary<string, byte[]>? entryOverrides = null)
    {
        string manifestJson = manifest ?? ManifestJson();
        using JsonDocument manifestDocument = JsonDocument.Parse(manifestJson);
        string themeId = manifestDocument.RootElement.GetProperty("id").GetString()
            ?? throw new InvalidOperationException("Theme fixture id is required.");
        var package = new MemoryStream();
        using (var archive = new ZipArchive(package, ZipArchiveMode.Create, leaveOpen: true))
        {
            var entries = new Dictionary<string, byte[]>(StringComparer.Ordinal)
            {
                ["manifest.json"] = Encoding.UTF8.GetBytes(manifestJson),
                ["styles/tokens.css"] = Encoding.UTF8.GetBytes(
                    $":root[data-theme=\"{themeId}\"] {{ --fsus-color-page-bg: #fff; }}"),
                ["styles/theme.css"] = Encoding.UTF8.GetBytes(
                    $"[data-theme=\"{themeId}\"] .fsus-theme-scope {{ background: var(--fsus-color-page-bg); }}"),
                ["assets/preview.png"] = [0x89, 0x50, 0x4e, 0x47],
                ["config/schema.json"] = Encoding.UTF8.GetBytes(
                    """{"type":"object","additionalProperties":false,"properties":{"fontScale":{"type":"number"},"showAuthor":{"type":"boolean"}}}""")
            };
            if (entryOverrides is not null)
            {
                foreach ((string path, byte[] content) in entryOverrides)
                {
                    entries[path] = content;
                }
            }
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
                    "maxSelectors": 512,
                    "maxSelectorDepth": 4,
                    "maxImportant": 8,
                    "maxMotionDurationMs": 1000,
                    "previewBytes": 262144
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

    private sealed class RecordingThemeEffects : IThemeActivationEffects
    {
        public List<bool> Invalidations
        {
            get;
        } = [];

        public bool Fail
        {
            get;
            set;
        }

        public Task PublishAsync(
            ThemeActivationHistorySnapshot transition,
            bool invalidateSharedAssets,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Invalidations.Add(invalidateSharedAssets);
            if (Fail)
            {
                throw new InvalidOperationException("asset cache unavailable");
            }

            return Task.CompletedTask;
        }
    }
}
