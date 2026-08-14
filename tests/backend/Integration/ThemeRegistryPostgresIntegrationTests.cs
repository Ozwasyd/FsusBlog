using System.IO.Compression;
using System.Text;

using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.SchemaMigration.Definitions;
using FsusBlog.Server.Infrastructure.Themes;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ThemeRegistryPostgresIntegrationTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task Registry_PersistsLifecycleConfigActivationAndAssetsAtomically()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await ApplyThemeMigrationsAsync(db);

        var registry = new PostgresThemeRegistry(db);
        var validator = new ThemePackageValidator();
        DateTimeOffset installedAt = DateTimeOffset.Parse(
            "2026-07-24T00:00:00Z",
            System.Globalization.CultureInfo.InvariantCulture);
        using MemoryStream firstStream = CreatePackage(
            "fsusblog.theme.minimal-ink",
            "Minimal Ink",
            "1.0.0");
        ValidatedThemePackage first = validator.Validate(firstStream, new Version(1, 3, 0));
        await registry.InstallAsync(first, "/themes/minimal-ink", installedAt, CancellationToken.None);
        await registry.SaveConfigAsync(
            first.Manifest.Id,
            """{"fontScale":1.125}""",
            version: 1,
            installedAt,
            CancellationToken.None);
        await registry.EnableAsync(
            ThemeActivationScope.Public,
            first.Manifest.Id,
            "auto",
            installedAt,
            CancellationToken.None);

        ThemeRegistrySnapshot? installed = await registry.GetThemeAsync(
            first.Manifest.Id,
            CancellationToken.None);
        ThemeActivationSnapshot? activation = await registry.GetActivationAsync(
            ThemeActivationScope.Public,
            CancellationToken.None);
        Assert.NotNull(installed);
        Assert.NotNull(activation);
        Assert.Equal(ThemeInstallState.Enabled, installed.InstallState);
        Assert.True(installed.Enabled);
        Assert.Equal("/themes/minimal-ink", installed.PackageLocation);
        Assert.Equal(first.PackageHash, installed.PackageHash);
        Assert.Equal(first.Manifest.Id, activation.ActiveThemeId);
        Assert.Equal(
            1,
            await db.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM theme_asset WHERE theme_id = @theme_id;",
                new SugarParameter("@theme_id", first.Manifest.Id)));

        ThemeLifecycleException active = await Assert.ThrowsAsync<ThemeLifecycleException>(
            () => registry.UninstallAsync(
                first.Manifest.Id,
                replacementThemeId: null,
                installedAt.AddMinutes(1),
                CancellationToken.None));
        Assert.Equal("theme_uninstall_active_replacement_required", active.ErrorCode);
        Assert.Equal(
            first.Manifest.Id,
            (await registry.GetActivationAsync(
                ThemeActivationScope.Public,
                CancellationToken.None))?.ActiveThemeId);

        using MemoryStream replacementStream = CreatePackage(
            "fsusblog.theme.paper",
            "Paper",
            "2.0.0");
        ValidatedThemePackage replacement = validator.Validate(
            replacementStream,
            new Version(1, 3, 0));
        await registry.InstallAsync(
            replacement,
            "/themes/paper",
            installedAt.AddMinutes(2),
            CancellationToken.None);
        await registry.UninstallAsync(
            first.Manifest.Id,
            replacement.Manifest.Id,
            installedAt.AddMinutes(3),
            CancellationToken.None);

        ThemeRegistrySnapshot? uninstalled = await registry.GetThemeAsync(
            first.Manifest.Id,
            CancellationToken.None);
        ThemeRegistrySnapshot? enabledReplacement = await registry.GetThemeAsync(
            replacement.Manifest.Id,
            CancellationToken.None);
        ThemeActivationSnapshot? replacedActivation = await registry.GetActivationAsync(
            ThemeActivationScope.Public,
            CancellationToken.None);
        Assert.NotNull(uninstalled);
        Assert.NotNull(enabledReplacement);
        Assert.NotNull(replacedActivation);
        Assert.Equal(ThemeInstallState.Uninstalled, uninstalled.InstallState);
        Assert.False(uninstalled.Enabled);
        Assert.Equal(ThemeInstallState.Enabled, enabledReplacement.InstallState);
        Assert.True(enabledReplacement.Enabled);
        Assert.Equal(replacement.Manifest.Id, replacedActivation.ActiveThemeId);
        Assert.Equal(
            0,
            await db.Ado.GetIntAsync(
                "SELECT COUNT(*) FROM theme_asset WHERE theme_id = @theme_id;",
                new SugarParameter("@theme_id", first.Manifest.Id)));
    }

    [Fact]
    public async Task Registry_RuntimeActivationRollbackRestoresVersionedStateAndHistory()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await ApplyThemeMigrationsAsync(db);
        var registry = new PostgresThemeRegistry(db);
        var validator = new ThemePackageValidator();
        DateTimeOffset now = DateTimeOffset.Parse(
            "2026-07-24T01:00:00Z",
            System.Globalization.CultureInfo.InvariantCulture);
        using MemoryStream firstStream = CreatePackage(
            "fsusblog.theme.runtime-first",
            "Runtime First",
            "1.0.0");
        using MemoryStream secondStream = CreatePackage(
            "fsusblog.theme.runtime-second",
            "Runtime Second",
            "1.0.0");
        ValidatedThemePackage first = validator.Validate(firstStream, new Version(1, 3, 0));
        ValidatedThemePackage second = validator.Validate(secondStream, new Version(1, 3, 0));
        await registry.InstallAsync(first, "/themes/runtime-first", now, CancellationToken.None);
        await registry.InstallAsync(second, "/themes/runtime-second", now, CancellationToken.None);
        await registry.SaveConfigAsync(
            first.Manifest.Id,
            """{"fontScale":1.1}""",
            1,
            now,
            CancellationToken.None);
        await registry.SaveConfigAsync(
            second.Manifest.Id,
            """{"fontScale":1.2}""",
            2,
            now,
            CancellationToken.None);
        await registry.ActivateAsync(
            ThemeActivationScope.SiteWide,
            first.Manifest.Id,
            first.PackageHash,
            1,
            "dark",
            "admin:integration",
            now,
            CancellationToken.None);
        ThemeActivationHistorySnapshot secondActivation = await registry.ActivateAsync(
            ThemeActivationScope.SiteWide,
            second.Manifest.Id,
            second.PackageHash,
            2,
            "light",
            "admin:integration",
            now.AddMinutes(1),
            CancellationToken.None);

        await registry.RollbackAsync(
            ThemeActivationScope.SiteWide,
            secondActivation.Id,
            "system:smoke",
            "post-activation smoke failed",
            now.AddMinutes(2),
            CancellationToken.None);

        ThemeActivationSnapshot? restored = await registry.GetActivationAsync(
            ThemeActivationScope.SiteWide,
            CancellationToken.None);
        Assert.NotNull(restored);
        Assert.Equal(first.Manifest.Id, restored.ActiveThemeId);
        Assert.Equal(first.PackageHash, restored.AssetVersion);
        Assert.Equal(1, restored.ConfigVersion);
        Assert.Equal("dark", restored.Mode);
        IReadOnlyList<ThemeActivationHistorySnapshot> history =
            await registry.GetActivationHistoryAsync(
                ThemeActivationScope.SiteWide,
                10,
                CancellationToken.None);
        Assert.Contains(
            history,
            static item => item.Status == ThemeActivationStatus.RolledBack
                && item.FailureReason == "post-activation smoke failed");
        Assert.All(
            history,
            static item => Assert.False(string.IsNullOrWhiteSpace(item.EvidenceJson)));
    }

    private static async Task ApplyThemeMigrationsAsync(SqlSugarClient db)
    {
        ISchemaMigrationDescriptor[] migrations =
        [
            ThemeRegistryMigrationDefinitions.BuildMigration(),
            ThemeActivationRuntimeMigrationDefinitions.BuildMigration()
        ];
        foreach (ISchemaMigrationDescriptor migration in migrations)
        {
            foreach (SchemaMigrationStep step in migration.Steps)
            {
                await step.ExecuteAsync(db, CancellationToken.None);
            }
        }
    }

    private static MemoryStream CreatePackage(string id, string name, string version)
    {
        var package = new MemoryStream();
        using (var archive = new ZipArchive(package, ZipArchiveMode.Create, leaveOpen: true))
        {
            WriteEntry(archive, "manifest.json", $$"""
                {
                    "id": "{{id}}",
                    "name": "{{name}}",
                    "version": "{{version}}",
                    "fsusblog": ">=1.3.0 <1.4.0",
                    "author": "integration",
                    "description": "Persistence integration fixture",
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
                        "script": false,
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
                """);
            WriteEntry(
                archive,
                "styles/tokens.css",
                $":root[data-theme=\"{id}\"] {{ --fsus-color-page-bg: #fff; }}");
            WriteEntry(
                archive,
                "styles/theme.css",
                $"[data-theme=\"{id}\"] .fsus-theme-scope {{ background: var(--fsus-color-page-bg); }}");
            WriteEntry(archive, "assets/preview.png", "PNG");
            WriteEntry(
                archive,
                "config/schema.json",
                """{"type":"object","additionalProperties":false,"properties":{"fontScale":{"type":"number"}}}""");
        }

        package.Position = 0;
        return package;
    }

    private static void WriteEntry(ZipArchive archive, string path, string content)
    {
        ZipArchiveEntry entry = archive.CreateEntry(path);
        using Stream stream = entry.Open();
        stream.Write(Encoding.UTF8.GetBytes(content));
    }
}
