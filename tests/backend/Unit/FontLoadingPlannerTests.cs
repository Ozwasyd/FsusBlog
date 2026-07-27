using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Fonts;
using FsusBlog.Shared.Contracts.Fonts;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests;

public sealed class FontLoadingPlannerTests
{
    [Fact]
    public async Task CreateAsync_IsDeterministicRouteLocaleAwareAndContentAddressed()
    {
        FontRegistrySnapshot snapshot = Snapshot(
            ui: Entry("fsusblog.font.fixture-ui", FontCategories.UiSans, "Fixture UI", "ui", ["en-US"],
                Face(400, critical: true, "aaaaaaaa"), Face(700, critical: false, "bbbbbbbb")),
            prose: Entry("fsusblog.font.fixture-prose", FontCategories.ProseSans, "Fixture Prose", "latin", ["en-US"],
                Face(400, critical: false, "cccccccc")),
            code: Entry("fsusblog.font.fixture-code", FontCategories.CodeMono, "Fixture Code", "latin", ["en-US"],
                Face(400, critical: false, "dddddddd")),
            cjk: Entry("fsusblog.font.fixture-cjk", FontCategories.CjkSans, "Fixture CJK", "Hant", ["zh-Hant"],
                Face(400, critical: true, "eeeeeeee"), Face(500, critical: false, "ffffffff")),
            emoji: Entry("fsusblog.font.fixture-emoji", FontCategories.Emoji, "Fixture Emoji", "emoji", ["und"],
                Face(400, critical: false, "11111111")));
        IFontLoadingPlanner planner = Planner(snapshot);
        var request = new FontLoadingPlanRequest(
            FontActivation.DefaultScope,
            FontLoadingPlanRoutes.Article,
            Locale: "zh-Hant",
            HasCode: true,
            HasEmoji: true);

        FontLoadingPlan first = await planner.CreateAsync(request);
        FontLoadingPlan second = await planner.CreateAsync(request);

        Assert.Equal(FontLoadingPlanner.Schema, first.Schema);
        Assert.Equal(12, first.ConfigVersion);
        Assert.Equal("Hant", first.Script);
        Assert.Equal(first.Evidence.PlanHash, second.Evidence.PlanHash);
        Assert.Equal("ok", first.Evidence.Status);
        Assert.Equal(2, first.Critical.Count);
        Assert.Equal(5, first.Deferred.Count);
        Assert.All(
            first.Critical.Concat(first.Deferred),
            face =>
            {
                Assert.StartsWith("/font-assets/", face.AssetUrl, StringComparison.Ordinal);
                Assert.EndsWith(".woff2", face.AssetUrl, StringComparison.Ordinal);
                Assert.Contains(face.ContentHash, face.AssetUrl, StringComparison.Ordinal);
                Assert.Equal(64, face.ContentHash.Length);
                Assert.Equal(FontDisplayModes.Swap, face.FontDisplay);
            });
        Assert.Contains(first.Deferred, face => face.Category == FontCategories.ProseSans && face.Trigger == FontLoadingPlanTriggers.Route);
        Assert.Contains(first.Deferred, face => face.Category == FontCategories.CodeMono && face.Trigger == FontLoadingPlanTriggers.Content);
        Assert.Contains(first.Deferred, face => face.Category == FontCategories.Emoji && face.Trigger == FontLoadingPlanTriggers.Content);
        Assert.Contains("fsusblog.font.fixture-code:400:normal", first.RouteFaces[FontLoadingPlanRoutes.Admin]);
        Assert.Contains("fsusblog.font.fixture-cjk:400:normal", first.LocaleFaces["zh-Hant"]);
        Assert.All(first.FallbackStacks.Values, value => Assert.False(string.IsNullOrWhiteSpace(value)));
    }

    [Fact]
    public async Task CreateAsync_DeduplicatesIdenticalActivatedFaceContent()
    {
        FontRegistrySnapshot snapshot = Snapshot(
            ui: Entry("fsusblog.font.fixture-ui", FontCategories.UiSans, "Fixture UI", "latin", ["en-US"],
                Face(400, critical: true, "samehash")),
            prose: Entry("fsusblog.font.fixture-prose", FontCategories.ProseSans, "Fixture Prose", "latin", ["en-US"],
                Face(400, critical: false, "samehash")),
            code: FontBuiltIns.CodeMono,
            cjk: FontBuiltIns.CjkSans,
            emoji: FontBuiltIns.Emoji);

        FontLoadingPlan result = await Planner(snapshot).CreateAsync(
            new FontLoadingPlanRequest(
                FontActivation.DefaultScope,
                FontLoadingPlanRoutes.Article));

        Assert.Single(result.Critical);
        Assert.Empty(result.Deferred);
        Assert.Equal(1, result.Evidence.DuplicateFaceCount);
    }

    [Fact]
    public async Task CreateAsync_RejectsExcessivePreloadCount()
    {
        FontRegistryEntry ui = Entry(
            "fsusblog.font.fixture-ui",
            FontCategories.UiSans,
            "Fixture UI",
            "latin",
            ["en-US"],
            Face(300, critical: true, "hash300"),
            Face(400, critical: true, "hash400"),
            Face(500, critical: true, "hash500"));
        FontRegistrySnapshot snapshot = Snapshot(
            ui,
            FontBuiltIns.ProseSans,
            FontBuiltIns.CodeMono,
            FontBuiltIns.CjkSans,
            FontBuiltIns.Emoji);

        FontLoadingPlanException error = await Assert.ThrowsAsync<FontLoadingPlanException>(
            () => Planner(snapshot).CreateAsync(
                new FontLoadingPlanRequest(
                    FontActivation.DefaultScope,
                    FontLoadingPlanRoutes.Shell,
                    MaxPreloads: 2)));

        Assert.Equal("font_preload_budget_exceeded", error.Code);
    }

    [Fact]
    public async Task CreateAsync_MissingScopeAndInvalidSelectionKeepSafeFallbackStacks()
    {
        FontRegistrySnapshot snapshot = Snapshot(
            FontBuiltIns.UiSans,
            FontBuiltIns.ProseSans,
            FontBuiltIns.CodeMono,
            FontBuiltIns.CjkSans,
            FontBuiltIns.Emoji);

        FontLoadingPlan result = await Planner(snapshot).CreateAsync(
            new FontLoadingPlanRequest(
                "missing-scope",
                FontLoadingPlanRoutes.Admin,
                Locale: "ja-JP",
                HasCode: true));

        Assert.True(result.UsedSafeFallback);
        Assert.Empty(result.Critical);
        Assert.Empty(result.Deferred);
        Assert.Contains("system-ui", result.FallbackStacks[FontTokenSchema.Family.Ui], StringComparison.Ordinal);
        Assert.Contains("monospace", result.FallbackStacks[FontTokenSchema.Family.Code], StringComparison.Ordinal);
    }

    [Fact]
    public async Task SerializeEvidence_EmitsBoundedMachineReadableReceipt()
    {
        FontLoadingPlan plan = await Planner(
            Snapshot(
                FontBuiltIns.UiSans,
                FontBuiltIns.ProseSans,
                FontBuiltIns.CodeMono,
                FontBuiltIns.CjkSans,
                FontBuiltIns.Emoji))
            .CreateAsync(new FontLoadingPlanRequest(
                FontActivation.DefaultScope,
                FontLoadingPlanRoutes.Shell));

        string evidence = FontLoadingPlanner.SerializeEvidence(plan);
        using JsonDocument document = JsonDocument.Parse(evidence);

        Assert.Equal(
            FontLoadingPlanner.EvidenceSchema,
            document.RootElement.GetProperty("schema").GetString());
        Assert.Equal("ok", document.RootElement.GetProperty("status").GetString());
        Assert.Equal(64, document.RootElement.GetProperty("planHash").GetString()!.Length);
        Assert.False(document.RootElement.TryGetProperty("fallbackStacks", out _));
        Assert.DoesNotContain("family", evidence, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RuntimeServices_RegisterPlannerWithRegistryAndTokenRuntime()
    {
        string root = Path.Combine(Path.GetTempPath(), $"fsusblog-font-planner-{Guid.NewGuid():N}");
        var configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["FSUSBLOG_DATA_ROOT"] = root
            })
            .Build();
        var services = new ServiceCollection();

        services.AddFsusRuntimeServices(configuration);

        ServiceDescriptor descriptor = Assert.Single(
            services,
            item => item.ServiceType == typeof(IFontLoadingPlanner));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        using ServiceProvider provider = services.BuildServiceProvider();
        Assert.IsType<FontLoadingPlanner>(provider.GetRequiredService<IFontLoadingPlanner>());
    }

    private static IFontLoadingPlanner Planner(FontRegistrySnapshot snapshot)
    {
        var registry = new SnapshotFontRegistry(snapshot);
        return new FontLoadingPlanner(registry, new FontStackRuntime(registry));
    }

    private static FontRegistrySnapshot Snapshot(
        FontRegistryEntry ui,
        FontRegistryEntry prose,
        FontRegistryEntry code,
        FontRegistryEntry cjk,
        FontRegistryEntry emoji)
    {
        FontRegistryEntry[] selected = [ui, prose, code, cjk, emoji];
        IReadOnlyList<FontRegistryEntry> fonts =
        [
            .. FontBuiltIns.All,
            .. selected.Where(item => !item.BuiltIn).DistinctBy(item => item.Id)
        ];
        return new FontRegistrySnapshot(
            fonts,
            [
                new FontActivation(
                    FontActivation.DefaultScope,
                    ui.Id,
                    prose.Id,
                    code.Id,
                    cjk.Id,
                    emoji.Id,
                    12,
                    DateTimeOffset.UnixEpoch)
            ]);
    }

    private static FontRegistryEntry Entry(
        string id,
        string category,
        string family,
        string script,
        IReadOnlyList<string> locales,
        params FontRegistryFace[] faces)
    {
        var manifest = new FontManifest(
            id,
            id,
            "1.0.0",
            ">=1.3.0 <1.4.0",
            "font",
            family,
            category,
            [script],
            locales,
            [
                .. faces.Select(face => new FontFaceDescriptor(
                    face.Weight,
                    face.Style,
                    $"fonts/{face.Weight}.woff2",
                    face.ContentHash,
                    face.UnicodeRange,
                    face.Critical))
            ],
            new FontLicenseDescriptor("OFL-1.1", "license/LICENSE.txt", "license/source.json"),
            new FontSourceDescriptor(
                "npm-fontsource",
                "@fontsource/fixture",
                "1.0.0",
                "Fixture upstream"),
            new FontBudgetDescriptor(
                faces.Where(face => face.Critical).Sum(face => face.SizeBytes),
                faces.Sum(face => face.SizeBytes),
                faces.Length),
            new FontLoadingDescriptor(
                FontDisplayModes.Swap,
                [.. faces.Where(face => face.Critical).Select(face => face.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture))],
                [.. faces.Where(face => !face.Critical).Select(face => face.Weight.ToString(System.Globalization.CultureInfo.InvariantCulture))]));
        return new FontRegistryEntry(
            id,
            id,
            family,
            category,
            "1.0.0",
            JsonSerializer.Serialize(manifest, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
            "fixture license",
            "{}",
            FontInstallStates.Installed,
            Enabled: true,
            BuiltIn: false,
            DateTimeOffset.UnixEpoch,
            DateTimeOffset.UnixEpoch,
            faces);
    }

    private static FontRegistryFace Face(int weight, bool critical, string hash)
    {
        string contentHash = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(hash)));
        return new FontRegistryFace(
            weight,
            FontFaceStyles.Normal,
            $"assets/{contentHash}.woff2",
            contentHash,
            1024,
            "U+0000-00FF",
            critical,
            FontDisplayModes.Swap);
    }

    private sealed class SnapshotFontRegistry(FontRegistrySnapshot snapshot) : IFontRegistry
    {
        public Task<FontRegistrySnapshot> ReadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public Task<FontRegistryEntry> InstallAsync(
            ValidatedFontPackage package,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<FontRegistryEntry> SetEnabledAsync(
            string id,
            bool enabled,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<FontRegistryPreview> PreviewAsync(
            string id,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<FontActivation> ActivateAsync(
            string scope,
            FontActivationSelection selection,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task DeleteAsync(
            string id,
            FontActivationSelection? replacement = null,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }
}
