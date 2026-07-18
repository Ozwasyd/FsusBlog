using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class ModerationRegionCatalogServiceTests
{
    [Fact]
    public void CurrentSnapshot_WithoutOverride_ResolvesCanonicalConfigurationRoot()
    {
        string contentRoot = System.IO.Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend");
        var environment = new TestWebHostEnvironment(contentRoot);
        IConfiguration configuration = new ConfigurationBuilder().Build();
        IModerationDictionaryService dictionaryService = new ModerationDictionaryService(
            environment,
            configuration,
            NullLogger<ModerationDictionaryService>.Instance,
            new AuditLogChannel());
        var service = new ModerationRegionCatalogService(
            environment,
            configuration,
            dictionaryService,
            NullLogger<ModerationRegionCatalogService>.Instance);

        ModerationRegionCatalogSnapshot snapshot = service.CurrentSnapshot;

        Assert.Contains(snapshot.Regions, static item => item.RegionCode == RegionCodes.MainlandChina);
        Assert.Contains(snapshot.PolicyTemplates, static item => item.TemplateId == "global-baseline");
    }

    [Fact]
    public void CurrentSnapshot_LoadsBuiltInRegionsGroupsAndTemplates()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var service = BuildService(root.Path);

        ModerationRegionCatalogSnapshot snapshot = service.CurrentSnapshot;

        Assert.Contains(snapshot.Regions, static item => item.RegionCode == RegionCodes.MainlandChina && item.PolicyTemplate == "cn-mainland-strict");
        Assert.Contains(snapshot.Regions, static item => item.RegionCode == RegionCodes.HongKong && item.PolicyTemplate is null);
        Assert.Contains(snapshot.RegionGroups, static item => item.GroupCode == ModerationRegionGroups.GreaterChina && item.PolicyTemplate is null);
        Assert.Contains(snapshot.PolicyTemplates, static item => item.TemplateId == "global-baseline");
        Assert.All(snapshot.PolicyTemplates, template =>
        {
            Assert.False(string.IsNullOrWhiteSpace(template.Source));
            Assert.False(string.IsNullOrWhiteSpace(template.Version));
            Assert.False(string.IsNullOrWhiteSpace(template.Checksum));
            Assert.False(string.IsNullOrWhiteSpace(template.ReviewedBy));
            if (template.Builtin)
            {
                Assert.True(template.NotLegalAdvice);
            }
        });
    }

    [Fact]
    public void PreviewEffectivePolicy_CnMainlandStrictTemplateIsScopedOnlyToMainland()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var service = BuildService(root.Path);

        ModerationEffectivePolicyPreview mainland = service.PreviewEffectivePolicy(RegionCodes.MainlandChina);
        ModerationEffectivePolicyPreview hongKong = service.PreviewEffectivePolicy(RegionCodes.HongKong);

        Assert.Contains(mainland.Inheritance, static item => item.SourceId == "cn-mainland-strict");
        Assert.Contains(mainland.Rules, static item => item.Category == ModerationRiskCategories.PoliticalSensitive);
        Assert.DoesNotContain(hongKong.Inheritance, static item => item.SourceId == "cn-mainland-strict");
        Assert.DoesNotContain(hongKong.Rules, static item => item.Category == ModerationRiskCategories.PoliticalSensitive);
    }

    [Fact]
    public void PreviewEffectivePolicy_EuRegionIncludesGroupTemplateBeforeRegionPolicyOverrides()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var service = BuildService(root.Path);

        ModerationEffectivePolicyPreview preview = service.PreviewEffectivePolicy(RegionCodes.Germany);

        Assert.Contains(ModerationRegionGroups.Europe, preview.RegionGroups);
        Assert.Contains(preview.Inheritance, static item => item.SourceId == "eu-illegal-content-baseline");
        Assert.Contains(preview.Inheritance, static item => item.Step == "region-policy:EU-DE");
        Assert.Contains(preview.Rules, static item => item.Category == "hate_speech" && item.SourceType == "operator_region_policy");
    }

    [Fact]
    public void PreviewEffectivePolicy_SupportsCustomRegionGroupAndTemplateFromConfig()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        string regionsPath = Path.Combine(root.Path, "regions.yaml");
        string raw = File.ReadAllText(regionsPath);
        raw = raw.Replace(
            "\nregion_groups:",
            """

              - region_code: CUSTOM-US-CAMPUS
                display_name: Custom US Campus
                parent_region: US
                primary_group: CUSTOM-US-CAMPUS-GROUP
                policy_template: custom-campus-template
                enabled: true
                builtin: false
                description: Operator custom campus policy.

            region_groups:
            """,
            StringComparison.Ordinal);
        raw += """

          - group_code: CUSTOM-US-CAMPUS-GROUP
            display_name: Custom US Campus Group
            policy_template: custom-campus-template
            builtin: false
            enabled: true
            regions: [CUSTOM-US-CAMPUS]
            description: Operator custom group.
        """;
        File.WriteAllText(regionsPath, raw);
        File.WriteAllText(Path.Combine(root.Path, "policy-templates", "custom-campus-template.yaml"), """
            template_id: custom-campus-template
            version: 2026-06
            scope: region
            region: CUSTOM-US-CAMPUS
            region_group: CUSTOM-US-CAMPUS-GROUP
            source: operator-config
            reviewed_by: campus-reviewer
            reviewed_at_utc: 2026-06-10T00:00:00Z
            is_builtin: false
            is_enabled: true
            not_legal_advice: true
            description: Operator custom reviewed template.
            rules:
              - category: harassment
                submit_action: manual_review
                display_action: manual_review_no_public_display
            """);
        var service = BuildService(root.Path);

        ModerationRegionCatalogSnapshot snapshot = service.CurrentSnapshot;
        ModerationEffectivePolicyPreview preview = service.PreviewEffectivePolicy("CUSTOM-US-CAMPUS");

        Assert.Contains(snapshot.Regions, static item => item.RegionCode == "CUSTOM-US-CAMPUS" && !item.Builtin);
        Assert.Contains(snapshot.RegionGroups, static item => item.GroupCode == "CUSTOM-US-CAMPUS-GROUP" && !item.Builtin);
        Assert.Contains(snapshot.PolicyTemplates, static item => item.TemplateId == "custom-campus-template" && item.ReviewedAtUtc is not null);
        Assert.Contains(preview.Rules, static item => item.Category == "harassment" && item.SourceId == "custom-campus-template");
    }

    private static ModerationRegionCatalogService BuildService(string root)
    {
        IConfiguration config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:DictionaryRoot"] = root,
                ["Moderation:RegionCatalogRoot"] = root
            })
            .Build();
        IModerationDictionaryService dictionaryService = new ModerationDictionaryService(
            new TestWebHostEnvironment(root),
            config,
            NullLogger<ModerationDictionaryService>.Instance,
            new AuditLogChannel());
        return new ModerationRegionCatalogService(
            new TestWebHostEnvironment(root),
            config,
            dictionaryService,
            NullLogger<ModerationRegionCatalogService>.Instance);
    }

    private sealed class TestRoot : IDisposable
    {
        private TestRoot(string path)
        {
            Path = path;
        }

        public string Path
        {
            get;
        }

        public static TestRoot FromRepoConfig()
        {
            string root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsus-moderation-region-tests", Guid.NewGuid().ToString("N"));
            CopyDirectory(System.IO.Path.Combine(BackendTestPaths.RepositoryRoot, "config", "moderation"), root);
            return new TestRoot(root);
        }

        public void Dispose()
        {
            if (Directory.Exists(Path))
            {
                Directory.Delete(Path, recursive: true);
            }
        }

        private static void CopyDirectory(string source, string destination)
        {
            Directory.CreateDirectory(destination);
            foreach (string directory in Directory.EnumerateDirectories(source, "*", SearchOption.AllDirectories))
            {
                Directory.CreateDirectory(directory.Replace(source, destination, StringComparison.Ordinal));
            }

            foreach (string file in Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories))
            {
                File.Copy(file, file.Replace(source, destination, StringComparison.Ordinal), overwrite: true);
            }
        }
    }

    private sealed class TestWebHostEnvironment(string root) : IWebHostEnvironment
    {
        public string ApplicationName { get; set; } = nameof(ModerationRegionCatalogServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = System.IO.Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
