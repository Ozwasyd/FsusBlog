using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class ModerationDictionaryServiceTests
{
    [Theory]
    [InlineData("")]
    [InlineData("src/backend")]
    public void CurrentSnapshot_WithoutOverride_ResolvesCanonicalConfigurationRoot(string contentRootRelativePath)
    {
        string contentRoot = string.IsNullOrEmpty(contentRootRelativePath)
            ? BackendTestPaths.RepositoryRoot
            : System.IO.Path.Combine(BackendTestPaths.RepositoryRoot, contentRootRelativePath);
        var service = new ModerationDictionaryService(
            new TestWebHostEnvironment(contentRoot),
            new ConfigurationBuilder().Build(),
            NullLogger<ModerationDictionaryService>.Instance);

        ModerationDictionarySnapshot snapshot = service.CurrentSnapshot;

        Assert.Contains("global.advertising", snapshot.Dictionaries.Keys);
        Assert.Contains(RegionCodes.MainlandChina, snapshot.RegionPolicies.Keys);
    }

    [Fact]
    public void CurrentSnapshot_LoadsYamlDictionariesAndPolicies()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var channel = new AuditLogChannel();
        var service = BuildService(root.Path, channel);

        ModerationDictionarySnapshot snapshot = service.CurrentSnapshot;

        Assert.NotSame(ModerationDictionarySnapshot.Empty, snapshot);
        Assert.Contains("global.advertising", snapshot.Dictionaries.Keys);
        Assert.Contains("cn-mainland.political-sensitive", snapshot.Dictionaries.Keys);
        Assert.Contains(RegionCodes.MainlandChina, snapshot.RegionPolicies.Keys);
        Assert.All(snapshot.Dictionaries.Values, dictionary =>
        {
            Assert.False(string.IsNullOrWhiteSpace(dictionary.Source));
            Assert.False(string.IsNullOrWhiteSpace(dictionary.ReviewedBy));
            Assert.False(string.IsNullOrWhiteSpace(dictionary.Checksum));
        });
        IReadOnlyList<AuditRecord> auditRecords = Drain(channel);
        Assert.Contains(auditRecords, static item => item.EventInfo == "dictionary_loaded");
        Assert.Contains(auditRecords, static item => item.EventInfo == "region_policy_loaded");
        Assert.Contains(auditRecords, static item => item.Action == AuditActionCatalog.ModerationRegionPolicyLoaded);
        Assert.All(auditRecords, static item =>
            Assert.Equal(item.Action, AuditRetentionCatalog.GetRequired(item.Action).Action));
        Assert.DoesNotContain(auditRecords, static item => item.ContextJson?.Contains("\"value\"", StringComparison.Ordinal) is true);
    }

    [Fact]
    public void Match_RedactsHighRiskEvidenceAndKeepsCategory()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var service = BuildService(root.Path);

        IReadOnlyList<ModerationDictionaryMatch> matches = service.Match("political_sensitive", RegionCodes.MainlandChina);

        ModerationDictionaryMatch match = Assert.Single(matches, static item => item.Category == ModerationRiskCategories.PoliticalSensitive);
        Assert.Equal(ModerationEvidencePolicies.Redact, match.EvidencePolicy);
        Assert.Null(match.Evidence);
        Assert.Equal("cn_mainland_political_sensitive", match.Reason);
    }

    [Fact]
    public void ResolveAction_UsesRegionPolicyInsteadOfDictionaryAction()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var service = BuildService(root.Path);

        ModerationPolicyAction mainland = service.ResolveAction(RegionCodes.MainlandChina, ModerationRiskCategories.PoliticalSensitive);
        ModerationPolicyAction singapore = service.ResolveAction(RegionCodes.Singapore, "advertising");
        ModerationPolicyAction unitedStates = service.ResolveAction(RegionCodes.UnitedStates, "advertising");

        Assert.Equal(ModerationDictionaryActions.RejectSubmit, mainland.SubmitAction);
        Assert.Equal(ModerationDictionaryActions.GeoBlock, mainland.DisplayAction);
        Assert.Equal(ModerationDictionaryActions.ManualReview, singapore.SubmitAction);
        Assert.Equal(ModerationDictionaryActions.Allow, singapore.DisplayAction);
        Assert.Equal(ModerationDictionaryActions.Allow, unitedStates.SubmitAction);
        Assert.Equal(ModerationDictionaryActions.Allow, unitedStates.DisplayAction);
    }

    [Fact]
    public void Reload_WhenSnapshotBuildFails_KeepsPreviousSnapshot()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var channel = new AuditLogChannel();
        var service = BuildService(root.Path, channel);
        ModerationDictionarySnapshot previous = service.CurrentSnapshot;
        Drain(channel);
        File.WriteAllText(Path.Combine(root.Path, "region-policies", "cn-mainland.yaml"), """
            region: CN-MAINLAND
            version: broken
            inherits:
              - GLOBAL
            dictionaries:
              - cn-mainland.political-sensitive
            rules:
            """);

        var result = service.Reload();

        Assert.True(result.IsFailure);
        Assert.Same(previous, service.CurrentSnapshot);
        Assert.False(string.IsNullOrWhiteSpace(service.LastError));
        IReadOnlyList<AuditRecord> auditRecords = Drain(channel);
        Assert.Contains(auditRecords, static item => item.EventInfo == "dictionary_reload_failed");
        Assert.Contains(auditRecords, static item => item.EventInfo == "region_policy_reload_failed");
    }

    [Fact]
    public void Reload_WhenChecksumChanges_RecordsChecksumAudit()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var channel = new AuditLogChannel();
        var service = BuildService(root.Path, channel);
        _ = service.CurrentSnapshot;
        Drain(channel);
        File.AppendAllText(
            Path.Combine(root.Path, "dictionaries", "global", "scam.yaml"),
            "\n  - value: checksum_changed_marker\n    aliases: []\n    severity: high\n    reason: scam_detected\n    evidence_policy: show_category_only\n");

        var result = service.Reload();

        Assert.True(result.IsSuccess);
        IReadOnlyList<AuditRecord> auditRecords = Drain(channel);
        Assert.Contains(auditRecords, static item => item.EventInfo == "dictionary_checksum_changed");
    }

    [Fact]
    public void Rollback_RestoresPreviousSuccessfulSnapshot()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var service = BuildService(root.Path);
        ModerationDictionarySnapshot previous = service.CurrentSnapshot;
        File.AppendAllText(
            Path.Combine(root.Path, "dictionaries", "global", "scam.yaml"),
            "\n  - value: rollback_marker\n    aliases: []\n    severity: high\n    reason: scam_detected\n    evidence_policy: show_category_only\n");

        var reload = service.Reload();
        ModerationDictionarySnapshot changed = service.CurrentSnapshot;
        var rollback = service.Rollback();

        Assert.True(reload.IsSuccess);
        Assert.NotSame(previous, changed);
        Assert.True(rollback.IsSuccess);
        Assert.Same(previous, service.CurrentSnapshot);
    }

    [Fact]
    public void ResolveAction_WhenRegionalPolicyDisabled_FallsBackToGlobalBaseline()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var runtimeState = new ModerationRuntimeStateService(new ConfigurationBuilder().Build(), new TestWebHostEnvironment(root.Path));
        var disabled = runtimeState.SetRegionState(
            RegionCodes.Singapore,
            ModerationRegionStates.Disabled,
            "unit-test",
            null,
            confirmPhrase: null,
            changedBy: "admin");
        var service = BuildService(root.Path, runtimeState: runtimeState);

        ModerationPolicyAction action = service.ResolveAction(RegionCodes.Singapore, "advertising");
        IReadOnlyList<ModerationDictionaryMatch> matches = service.Match("私聊赚钱", RegionCodes.Singapore);

        Assert.True(disabled.IsSuccess);
        Assert.Equal(ModerationDictionaryActions.ManualReview, action.SubmitAction);
        Assert.Equal(ModerationDictionaryActions.ManualReviewNoPublicDisplay, action.DisplayAction);
        Assert.Contains(matches, static item => item.DictionaryId == "global.advertising");
    }

    [Fact]
    public void ContentFilterService_LoadsGlobalYamlHardSecurityDictionaryWithoutRegionalLeakage()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var dictionaryService = BuildService(root.Path);
        using var contentFilter = new ContentFilterService(
            new TestWebHostEnvironment(root.Path),
            NullLogger<ContentFilterService>.Instance,
            dictionaryService);

        ContentValidationResult globalResult = contentFilter.ValidateContent("这里出现恶意链接");
        ContentValidationResult regionalResult = contentFilter.ValidateContent("sg_harmony_risk");

        Assert.False(globalResult.IsValid);
        Assert.Equal("malicious_link", globalResult.ReasonCode);
        Assert.True(regionalResult.IsValid);
    }

    [Fact]
    public void RegionLegalModeration_UsesPolicyComposedDictionariesForScopedMainlandBlocks()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var dictionaryService = BuildService(root.Path);
        var regionService = new RegionLegalModerationService(dictionaryService);

        RegionModerationDecision sg = regionService.EvaluateOnSubmit(MakeRequest("political_sensitive", RegionCodes.Singapore));
        RegionModerationDecision mainland = regionService.EvaluateOnSubmit(MakeRequest("political_sensitive", RegionCodes.MainlandChina));

        Assert.True(sg.CanPublish);
        Assert.Equal([RegionCodes.MainlandChina], sg.BlockedRegions);
        Assert.False(mainland.CanPublish);
    }

    [Fact]
    public void RegionLegalModeration_AppliesRegionalManualReviewActionsForGlobalAdvertising()
    {
        using TestRoot root = TestRoot.FromRepoConfig();
        var dictionaryService = BuildService(root.Path);
        var regionService = new RegionLegalModerationService(dictionaryService);

        RegionModerationDecision mainland = regionService.EvaluateOnSubmit(MakeRequest("私聊赚钱", RegionCodes.MainlandChina));
        RegionModerationDecision singapore = regionService.EvaluateOnSubmit(MakeRequest("私聊赚钱", RegionCodes.Singapore));
        RegionModerationDecision unitedStates = regionService.EvaluateOnSubmit(MakeRequest("私聊赚钱", RegionCodes.UnitedStates));

        Assert.True(mainland.CanPublish);
        Assert.True(mainland.RequiresManualReview);
        Assert.True(mainland.HideUntilReviewed);
        Assert.Equal("submit_region_manual_review_no_public_display", mainland.DecisionReason);
        Assert.True(singapore.CanPublish);
        Assert.True(singapore.RequiresManualReview);
        Assert.False(singapore.HideUntilReviewed);
        Assert.Equal("submit_region_manual_review", singapore.DecisionReason);
        Assert.True(unitedStates.CanPublish);
        Assert.False(unitedStates.RequiresManualReview);
        Assert.False(unitedStates.HideUntilReviewed);
        Assert.Equal("region_policy_allow", unitedStates.DecisionReason);
    }

    private static ModerationDictionaryService BuildService(
        string dictionaryRoot,
        AuditLogChannel? auditLogChannel = null,
        IModerationRuntimeStateService? runtimeState = null)
    {
        IConfiguration config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:DictionaryRoot"] = dictionaryRoot
            })
            .Build();
        return new ModerationDictionaryService(
            new TestWebHostEnvironment(dictionaryRoot),
            config,
            NullLogger<ModerationDictionaryService>.Instance,
            auditLogChannel,
            runtimeState);
    }

    private static IReadOnlyList<AuditRecord> Drain(AuditLogChannel channel)
    {
        var records = new List<AuditRecord>();
        while (channel.Reader.TryRead(out AuditRecord? record))
        {
            records.Add(record);
        }

        return records;
    }

    private static RegionModerationRequest MakeRequest(string content, string submitRegion)
        => new(
            content,
            ArticleId: 1,
            UserId: 7,
            submitRegion,
            SubmitRegionConfidence: 1d,
            RegionProvider: "unit-test",
            SubmitIpHash: "hash",
            UserAgent: null,
            SubmittedAtUtc: DateTime.UtcNow);

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
            string root = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "fsus-moderation-dictionary-tests", Guid.NewGuid().ToString("N"));
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
        public string ApplicationName { get; set; } = nameof(ModerationDictionaryServiceTests);
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string WebRootPath { get; set; } = System.IO.Path.Combine(root, "wwwroot");
        public string EnvironmentName { get; set; } = "Development";
        public string ContentRootPath { get; set; } = root;
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }
}
