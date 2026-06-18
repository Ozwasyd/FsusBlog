using FsusBlog.Server.Tests.TestInfrastructure;

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
        string bridge = Read("src/backend/Infrastructure/Middlewares/SecurityBinaryBridgeMiddleware.cs");
        string internalFilter = Read("src/backend/Infrastructure/Filters/BinaryBridgeInternalOnlyFilter.cs");
        string models = Read("src/backend/Models/Security/SecurityAdminModels.cs");
        string abstractions = Read("src/backend/Infrastructure/Security/SecurityRiskAbstractions.cs");
        string service = Read("src/backend/Services/Security/SecurityAdminPolicyService.cs");
        string registration = Read("src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs");
        string securityRegistration = Read("src/backend/Infrastructure/Bootstrap/RuntimeSecurityAndLifecycleServiceCollectionExtensions.cs");

        Assert.Contains("BinaryBridgeInternalRequest.SecurityPrefix", endpoints, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<BinaryBridgeInternalOnlyFilter>()", endpoints, StringComparison.Ordinal);
        Assert.Contains("\"/api/binary/admin/security\"", bridge, StringComparison.Ordinal);
        Assert.Contains("\"/_fsus/internal/binary-bridge/admin/security\"", internalFilter, StringComparison.Ordinal);
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
}
