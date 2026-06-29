using System.Reflection;
using System.Text.Json;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AntiCrawlerSecurityContractTests
{
    private static readonly string RepoRoot = BackendTestPaths.RepositoryRoot;

    [Fact]
    public void RateLimiter_UsesCrawlerAwarePartitionsAndRiskWrites()
    {
        string source = Read("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");

        Assert.Contains("options.OnRejected", source, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", source, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.RateLimited", source, StringComparison.Ordinal);
        Assert.Contains("IAntiCrawlerPolicyProvider", source, StringComparison.Ordinal);
        Assert.Contains("IsVerifiedCrawlerPublicRead", source, StringComparison.Ordinal);
        Assert.Contains("options.AddPolicy(\"read_proof\"", source, StringComparison.Ordinal);
        Assert.Contains("options.AddPolicy(\"public_read\"", source, StringComparison.Ordinal);
        Assert.Contains("public-read:verified-crawler", source, StringComparison.Ordinal);
        Assert.Contains("public-read:social", source, StringComparison.Ordinal);
    }

    [Fact]
    public void RateLimiter_RejectionRiskWriteUsesBoundedSampler()
    {
        string source = Read("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");
        int start = source.IndexOf("options.OnRejected", StringComparison.Ordinal);
        int end = source.IndexOf("options.AddPolicy(\"fixed_ip\"", start, StringComparison.Ordinal);
        string onRejected = source[start..end];

        Assert.Contains("RateLimiterRejectionRiskSampler", source, StringComparison.Ordinal);
        Assert.Contains("ShouldWriteRiskSignal", onRejected, StringComparison.Ordinal);
        Assert.Contains("RecordRateLimiterRiskSample", onRejected, StringComparison.Ordinal);
        Assert.Contains("RecordRateLimiterRiskDrop", onRejected, StringComparison.Ordinal);
    }

    [Fact]
    public void ProductionGateway_LimitsBinaryAuthAdminAndAuthorRoutes()
    {
        string gateway = Read("deploy/production-openresty.conf");

        Assert.Contains("zone=fsus_admin_limit", gateway, StringComparison.Ordinal);
        Assert.Contains("^/api/binary/auth(/|$)", gateway, StringComparison.Ordinal);
        Assert.Contains("^/api/binary/admin(/|$)", gateway, StringComparison.Ordinal);
        Assert.Contains("^/api/binary/author(/|$)", gateway, StringComparison.Ordinal);
        Assert.DoesNotContain("^/api/(Auth|auth|admin)(/|$)", gateway, StringComparison.Ordinal);
    }

    [Fact]
    public void FixedIpLimiter_DoesNotGiveAdminNoLimiterByRole()
    {
        string source = Read("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");

        Assert.DoesNotContain("GetNoLimiter(\"admin\")", source, StringComparison.Ordinal);
        Assert.Contains("RateLimiting:AdminPermitLimit", source, StringComparison.Ordinal);
        Assert.Contains("fixed-ip:admin:", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Shield_SeparatesSearchCrawlerSocialPreviewAndHardAbort()
    {
        string source = Read("src/backend/Infrastructure/Middlewares/ShieldMiddleware.cs");

        Assert.Contains("IAntiCrawlerPolicyProvider", source, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", source, StringComparison.Ordinal);
        Assert.Contains("SecuritySystemModes.Disabled", source, StringComparison.Ordinal);
        Assert.Contains("SecuritySystemModes.Observe", source, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.FakeCrawler", source, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.BlockedUserAgent", source, StringComparison.Ordinal);
        Assert.Contains("Twitterbot", source, StringComparison.Ordinal);
        Assert.Contains("facebookexternalhit", source, StringComparison.Ordinal);
        Assert.Contains("context.Items[\"VerifiedCrawler\"] = true", source, StringComparison.Ordinal);
        Assert.Contains("context.Items[\"SocialPreviewBot\"] = true", source, StringComparison.Ordinal);
        Assert.Contains("FsusObservability.RecordSecurityEvent(\"shield_reject\"", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CrawlerRanges_SupportRemoteSnapshotFallbackAndOpsStatus()
    {
        string worker = Read("src/backend/Services/Background/CrawlerUpdateWorker.cs");
        string detector = Read("src/backend/Services/Security/CrawlerDetectorService.cs");
        string health = Read("src/backend/Infrastructure/Operations/ProductionHealth.cs");
        string endpoints = Read("src/backend/Modules/Endpoints/SecurityEndpoints.cs");

        Assert.Contains("https://developers.google.com/static/search/apis/ipranges/googlebot.json", worker, StringComparison.Ordinal);
        Assert.Contains("https://www.bing.com/toolbox/bingbot.json", worker, StringComparison.Ordinal);
        Assert.Contains("CrawlerRangeSnapshot", worker, StringComparison.Ordinal);
        Assert.Contains("SelectRanges(remoteGoogle, snapshot?.Google, configGoogle)", worker, StringComparison.Ordinal);
        Assert.Contains("ICrawlerRangeSyncService", worker, StringComparison.Ordinal);
        Assert.Contains("CidrUpdateIntervalMinutes", worker, StringComparison.Ordinal);
        Assert.Contains("WaitForNextPolicyTickAsync", worker, StringComparison.Ordinal);
        Assert.Contains("GetRangeStatus()", detector, StringComparison.Ordinal);
        Assert.Contains("/api/ops/crawler-ranges/status", health, StringComparison.Ordinal);
        Assert.Contains("/anti-crawler/crawler-ranges/status", endpoints, StringComparison.Ordinal);
        Assert.Contains("/anti-crawler/crawler-ranges/sync", endpoints, StringComparison.Ordinal);
    }

    [Fact]
    public void CrawlerRanges_SourceWritesSnapshotWithTempRename()
    {
        string worker = Read("src/backend/Services/Background/CrawlerUpdateWorker.cs");

        Assert.Contains("WriteSnapshotAtomically(path, json)", worker, StringComparison.Ordinal);
        Assert.Contains("File.WriteAllText(tempPath, json)", worker, StringComparison.Ordinal);
        Assert.Contains("File.Move(tempPath, path, overwrite: true)", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("File.WriteAllText(path, json)", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void CrawlerRanges_AtomicSnapshotWriteProducesCompleteJson()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"fsus-crawler-snapshot-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string path = Path.Combine(directory, "crawler-ranges.snapshot.json");
            string json = """
                {"Google":["66.249.64.0/19"],"Bing":["40.77.167.0/24"],"SavedAt":"2026-06-25T00:00:00+00:00"}
                """;

            CrawlerUpdateWorker.WriteSnapshotAtomically(path, json);

            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            Assert.Equal("66.249.64.0/19", document.RootElement.GetProperty("Google")[0].GetString());
            Assert.Equal("40.77.167.0/24", document.RootElement.GetProperty("Bing")[0].GetString());
            Assert.Empty(Directory.GetFiles(directory, "*.tmp"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void CrawlerRanges_SourceUsesAtomicRuntimeStateForStatus()
    {
        string worker = Read("src/backend/Services/Background/CrawlerUpdateWorker.cs");

        Assert.Contains("CrawlerUpdateRuntimeState", worker, StringComparison.Ordinal);
        Assert.Contains("Volatile.Read(ref _runtimeState)", worker, StringComparison.Ordinal);
        Assert.Contains("PublishRuntimeState", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("DateTimeOffset? _nextSyncAt", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("DateTimeOffset? _lastStartedAt", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("DateTimeOffset? _lastFinishedAt", worker, StringComparison.Ordinal);
        Assert.DoesNotContain("volatile string _lastOutcome", worker, StringComparison.Ordinal);
    }

    [Fact]
    public void CrawlerRanges_SourceFetchesRemoteProvidersConcurrentlyAndCachesConfiguration()
    {
        string worker = Read("src/backend/Services/Background/CrawlerUpdateWorker.cs");
        string sync = Slice(worker, "private async Task<CrawlerRangeStatus> SynchronizeCoreAsync", "    private async Task WaitForNextPolicyTickAsync");
        string snapshotPath = Slice(worker, "private string ResolveSnapshotPath", "    private static RangeSelection SelectRanges");

        Assert.Contains("private readonly string? _configuredGoogleCidrs", worker, StringComparison.Ordinal);
        Assert.Contains("private readonly string? _configuredBingCidrs", worker, StringComparison.Ordinal);
        Assert.Contains("private readonly string? _configuredSnapshotPath", worker, StringComparison.Ordinal);
        Assert.Contains("private readonly string _dataRoot", worker, StringComparison.Ordinal);
        Assert.Contains("Task.WhenAll(remoteGoogleTask, remoteBingTask)", sync, StringComparison.Ordinal);
        Assert.Contains("ParseConfiguredCidrs(_configuredGoogleCidrs)", sync, StringComparison.Ordinal);
        Assert.Contains("ParseConfiguredCidrs(_configuredBingCidrs)", sync, StringComparison.Ordinal);
        Assert.DoesNotContain("_configuration[\"Security:CrawlerCidrs:Google\"]", sync, StringComparison.Ordinal);
        Assert.DoesNotContain("_configuration[\"Security:CrawlerCidrs:Bing\"]", sync, StringComparison.Ordinal);
        Assert.DoesNotContain("_configuration[\"Security:CrawlerCidrs:SnapshotPath\"]", snapshotPath, StringComparison.Ordinal);
        Assert.DoesNotContain("Environment.GetEnvironmentVariable", snapshotPath, StringComparison.Ordinal);
    }

    [Fact]
    public void CrawlerRanges_ExceptionPathPublishesFinishedStateBeforeClearingRunning()
    {
        string worker = Read("src/backend/Services/Background/CrawlerUpdateWorker.cs");
        string syncMethod = Slice(worker, "public async Task<CrawlerRangeSyncResponse> SynchronizeOnceAsync", "    private async Task<CrawlerRangeStatus> SynchronizeCoreAsync");
        string finallyBlock = Slice(syncMethod, "finally", "        return new CrawlerRangeSyncResponse");

        Assert.Contains("finalOutcome = ex.GetType().Name", syncMethod, StringComparison.Ordinal);
        Assert.Contains("PublishRuntimeState", finallyBlock, StringComparison.Ordinal);
        Assert.Contains("Running = false", finallyBlock, StringComparison.Ordinal);
        Assert.Contains("Volatile.Write(ref _running, 0)", finallyBlock, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("http://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("https://internal-admin/api/secrets")]
    [InlineData("https://169.254.169.254/latest/meta-data/")]
    public void CrawlerRangeResolver_RejectsUnsafeRemoteUrls(string configured)
    {
        var method = typeof(CrawlerUpdateWorker).GetMethod("ResolveUri", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        var ex = Assert.Throws<TargetInvocationException>(() => method.Invoke(null, [configured, new Uri("https://developers.google.com/static/search/apis/ipranges/googlebot.json")]));

        Assert.IsType<InvalidOperationException>(ex.InnerException);
    }

    [Theory]
    [InlineData(null, "https://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("https://developers.google.com/static/search/apis/ipranges/googlebot.json", "https://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("https://www.bing.com/toolbox/bingbot.json", "https://www.bing.com/toolbox/bingbot.json")]
    public void CrawlerRangeResolver_AcceptsOnlyOfficialHttpsUrls(string? configured, string expected)
    {
        var method = typeof(CrawlerUpdateWorker).GetMethod("ResolveUri", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        var uri = (Uri)method.Invoke(null, [configured, new Uri("https://developers.google.com/static/search/apis/ipranges/googlebot.json")])!;

        Assert.Equal(expected, uri.ToString());
    }

    [Theory]
    [InlineData("http://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("https://internal-admin/api/secrets")]
    public void SecurityAdminPolicy_RejectsUnsafeCrawlerRangeUrlUpdates(string configured)
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var request = new AntiCrawlerOptionsUpdateRequest(
            Mode: null,
            PublicReadChallengeEnabled: null,
            SearchCrawlerVerificationEnabled: null,
            SocialPreviewGuardEnabled: null,
            RiskScoringEnabled: null,
            EventPersistenceEnabled: null,
            DashboardAggregationEnabled: null,
            CidrAutoUpdateEnabled: null,
            IllegalPathHardAbortEnabled: null,
            RequireChallengeScore: null,
            BlockScore: null,
            MaxRiskScore: null,
            DefaultRiskTtlSeconds: null,
            ZeroRiskCacheTtlSeconds: null,
            FixedIpPermitLimit: null,
            FixedIpQueueLimit: null,
            VerifiedCrawlerFixedIpPermitLimit: null,
            PublicReadPermitLimit: null,
            PublicReadQueueLimit: null,
            VerifiedCrawlerPublicReadPermitLimit: null,
            SocialPreviewPublicReadPermitLimit: null,
            ReadProofPermitLimit: null,
            CidrUpdateIntervalMinutes: null,
            CidrInitialDelaySeconds: null,
            CidrMinUpdateIntervalMinutes: null,
            GoogleCrawlerRangesUrl: configured,
            BingCrawlerRangesUrl: null,
            SnapshotPath: null,
            SocialPreviewAllowedPathPrefixes: null,
            BlockedUserAgentKeywords: null,
            Reason: "test");

        Assert.Throws<ArgumentException>(() => service.UpdateAntiCrawlerOptions(request, "test"));
    }

    [Fact]
    public void PublicReadAndReadProof_AreRiskAware()
    {
        string comments = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string taxonomy = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs");
        string readProof = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.ReadProof.cs");
        string pow = Read("src/backend/Infrastructure/Filters/PowValidationLogic.cs");

        Assert.Contains("RequireRateLimiting(\"public_read\")", comments, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RiskAwarePublicReadFilter>()", comments, StringComparison.Ordinal);
        Assert.Contains("RequireRateLimiting(\"public_read\")", taxonomy, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RiskAwarePublicReadFilter>()", taxonomy, StringComparison.Ordinal);
        Assert.Contains("RequireRateLimiting(\"read_proof\")", readProof, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", readProof, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskSources.HumanReadProof", readProof, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.ReadProofAccepted", readProof, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.ReadProofRejected", readProof, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", pow, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskSources.Pow", pow, StringComparison.Ordinal);
        Assert.Contains("SecurityRiskReason.PowInvalid", pow, StringComparison.Ordinal);
        string publicReadFilter = Read("src/backend/Infrastructure/Filters/RiskAwarePublicReadFilter.cs");
        Assert.Contains("CurrentRiskPolicyV2", publicReadFilter, StringComparison.Ordinal);
        Assert.Contains("IRiskDecisionService", publicReadFilter, StringComparison.Ordinal);
    }

    [Fact]
    public void RiskControlTrackingPlan_DocumentsProductionRoadmap()
    {
        string security = Read("docs/security.md");
        string plan = Read("docs/risk-control-plan.md");
        string[] orderedSteps =
        [
            "Risk action registry",
            "Risk control context factory",
            "Risk policy snapshot v2",
            "Risk decision service",
            "Security challenge contract",
            "Challenge persistence schema",
            "Challenge proof token service",
            "Challenge orchestrator",
            "PoW provider migration",
            "RequiresRiskControlFilter",
            "CaptchaV1 backend",
            "CaptchaV1 frontend",
            "CaptchaV1 integration policy",
            "PoSpace contract/provider",
            "PoSpace frontend worker",
            "HumanReadProof risk integration",
            "Auth/recovery risk integration",
            "Anonymous comment risk integration",
            "Notification stream risk integration",
            "Admin risk console",
            "Risk simulator",
            "Metrics/audit/readiness",
            "Full test matrix",
            "Production rollout gates"
        ];

        Assert.Contains("docs/risk-control-plan.md", security, StringComparison.Ordinal);
        Assert.Contains("Risk Signal -> Risk Score -> Risk Decision -> Challenge Orchestration -> Proof Verification -> Enforcement -> Audit / Metrics / Admin Policy", plan, StringComparison.Ordinal);
        Assert.Contains("AEDS / binary contract first", plan, StringComparison.Ordinal);
        Assert.Contains("no public JSON fallback", plan, StringComparison.Ordinal);
        int previous = -1;
        foreach (string step in orderedSteps)
        {
            int current = plan.IndexOf(step, StringComparison.Ordinal);
            Assert.True(current > previous, $"RiskControl step missing or out of order: {step}");
            previous = current;
        }
    }

    [Fact]
    public void SecurityAdminConsole_SeparatesAntiCrawlerPowAndSecurityRisk()
    {
        string endpoints = Read("src/backend/Modules/Endpoints/SecurityEndpoints.cs");
        string models = Read("src/backend/Models/Security/SecurityAdminModels.cs");
        string abstractions = Read("src/backend/Infrastructure/Security/SecurityRiskAbstractions.cs");
        string service = Read("src/backend/Services/Security/SecurityAdminPolicyService.cs");
        string registration = Read("src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs");
        string securityRegistration = Read("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("\"/api/binary/admin/security\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("AedsJsonResults.Ok", endpoints, StringComparison.Ordinal);
        Assert.Contains("ReadRequestAsync<AntiCrawlerOptionsUpdateRequest>", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryBridgeInternalRequest.SecurityPrefix", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("BinaryBridgeInternalOnlyFilter", endpoints, StringComparison.Ordinal);
        Assert.Contains("/anti-crawler/overview", endpoints, StringComparison.Ordinal);
        Assert.Contains("/anti-crawler/options", endpoints, StringComparison.Ordinal);
        Assert.Contains("/pow/overview", endpoints, StringComparison.Ordinal);
        Assert.Contains("/pow/options", endpoints, StringComparison.Ordinal);
        Assert.Contains("/risk/events", endpoints, StringComparison.Ordinal);
        Assert.Contains("/risk/snapshots", endpoints, StringComparison.Ordinal);
        Assert.Contains("SecuritySystemModes", models, StringComparison.Ordinal);
        Assert.Contains("disabled", models, StringComparison.Ordinal);
        Assert.Contains("observe", models, StringComparison.Ordinal);
        Assert.Contains("enforce", models, StringComparison.Ordinal);
        Assert.Contains("strict", models, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskSignalSink", abstractions, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskScoreReader", abstractions, StringComparison.Ordinal);
        Assert.Contains("ISecurityRiskPolicyProvider", abstractions, StringComparison.Ordinal);
        Assert.Contains("security.pow", service, StringComparison.Ordinal);
        Assert.Contains("AddSingleton<ISecurityAdminPolicyService", registration, StringComparison.Ordinal);
        Assert.Contains("AddSingleton<ISecurityRiskSignalSink", registration, StringComparison.Ordinal);
        Assert.Contains("IRiskDecisionService", securityRegistration, StringComparison.Ordinal);
    }

    [Fact]
    public void SecurityAdminRiskListLimits_AreClampedAndRateLimited()
    {
        string endpoints = Read("src/backend/Modules/Endpoints/SecurityEndpoints.cs");
        string[] routes =
        [
            "group.MapGet(\"/anti-crawler/events\"",
            "group.MapGet(\"/anti-crawler/risk-events\"",
            "group.MapGet(\"/risk/events\"",
            "group.MapGet(\"/risk/snapshots\"",
            "group.MapGet(\"/pow/events\""
        ];

        foreach (string route in routes)
        {
            string block = ExtractRouteBlock(endpoints, route);
            Assert.Contains("ClampRiskListLimit(limit)", block, StringComparison.Ordinal);
            Assert.Contains(".RequireRateLimiting(\"fixed_ip\")", block, StringComparison.Ordinal);
        }

        Assert.DoesNotContain("limit ?? 100", endpoints, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(null, 100)]
    [InlineData(-1, 1)]
    [InlineData(0, 1)]
    [InlineData(50, 50)]
    [InlineData(2147483647, 1000)]
    public void ClampRiskListLimit_ClampsUntrustedAdminInput(int? input, int expected)
    {
        var method = typeof(SecurityEndpoints).GetMethod("ClampRiskListLimit", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(method);

        int result = (int)method.Invoke(null, [input])!;

        Assert.Equal(expected, result);
    }

    [Fact]
    public void DistributionResources_UseCdnFriendlyCacheAndExplicitRobotsPolicy()
    {
        string endpoints = Read("src/backend/Modules/Endpoints/DistributionEndpoints.cs");
        string service = Read("src/backend/Services/Distribution/BlogDistributionService.cs");

        Assert.DoesNotContain("no-cache", endpoints, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("stale-while-revalidate=300", endpoints, StringComparison.Ordinal);
        Assert.Contains("CacheOutput(static builder => ApplyDistributionCache(builder))", endpoints, StringComparison.Ordinal);
        Assert.Contains("CacheTag.ArticleList.ToOutputCacheTag()", endpoints, StringComparison.Ordinal);
        Assert.Contains("CacheTag.Seo.ToOutputCacheTag()", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("Headers.ETag", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("Status304NotModified", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("SHA256.HashData", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("IfNoneMatch", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain(".Split(", endpoints, StringComparison.Ordinal);
        Assert.Contains("Disallow: /api/", service, StringComparison.Ordinal);
        Assert.Contains("Allow: /api/public/", service, StringComparison.Ordinal);
        Assert.Contains("Disallow: /search/index.bin", service, StringComparison.Ordinal);
        Assert.Contains("Disallow: /search/patches/", service, StringComparison.Ordinal);
    }

    private static string Read(string relativePath)
        => File.ReadAllText(Path.Combine(RepoRoot, relativePath));

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }

    private static string ExtractRouteBlock(string source, string routeSignature)
    {
        int start = source.IndexOf(routeSignature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing route marker: {routeSignature}");
        int next = source.IndexOf("\n\n        group.Map", start + routeSignature.Length, StringComparison.Ordinal);
        if (next < 0)
        {
            next = source.IndexOf("\n    private", start + routeSignature.Length, StringComparison.Ordinal);
        }

        Assert.True(next > start, $"Missing route end for: {routeSignature}");
        return source[start..next];
    }
}
