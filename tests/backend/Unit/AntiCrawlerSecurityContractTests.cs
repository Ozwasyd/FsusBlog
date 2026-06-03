namespace FsusBlog.Server.Tests.Unit;

public sealed class AntiCrawlerSecurityContractTests
{
    private static readonly string RepoRoot = ResolveRepoRoot();

    [Fact]
    public void RateLimiter_UsesCrawlerAwarePartitionsAndRiskWrites()
    {
        string source = Read("src/backend/Infrastructure/Bootstrap/ServiceCollectionExtensions.cs");

        Assert.Contains("options.OnRejected", source, StringComparison.Ordinal);
        Assert.Contains("CrawlerRiskReason.RateLimited", source, StringComparison.Ordinal);
        Assert.Contains("IsVerifiedCrawlerPublicRead", source, StringComparison.Ordinal);
        Assert.Contains("options.AddPolicy(\"read_proof\"", source, StringComparison.Ordinal);
        Assert.Contains("options.AddPolicy(\"public_read\"", source, StringComparison.Ordinal);
        Assert.Contains("public-read:verified-crawler", source, StringComparison.Ordinal);
        Assert.Contains("public-read:social", source, StringComparison.Ordinal);
    }

    [Fact]
    public void Shield_SeparatesSearchCrawlerSocialPreviewAndHardAbort()
    {
        string source = Read("src/backend/Infrastructure/Middlewares/ShieldMiddleware.cs");

        Assert.Contains("CrawlerRiskReason.FakeCrawler", source, StringComparison.Ordinal);
        Assert.Contains("CrawlerRiskReason.BlockedUserAgent", source, StringComparison.Ordinal);
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

        Assert.Contains("https://developers.google.com/static/search/apis/ipranges/googlebot.json", worker, StringComparison.Ordinal);
        Assert.Contains("https://www.bing.com/toolbox/bingbot.json", worker, StringComparison.Ordinal);
        Assert.Contains("CrawlerRangeSnapshot", worker, StringComparison.Ordinal);
        Assert.Contains("SelectRanges(remoteGoogle, snapshot?.Google, configGoogle)", worker, StringComparison.Ordinal);
        Assert.Contains("GetRangeStatus()", detector, StringComparison.Ordinal);
        Assert.Contains("/api/ops/crawler-ranges/status", health, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicReadAndReadProof_AreRiskAware()
    {
        string comments = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string taxonomy = Read("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Taxonomy.cs");
        string distribution = Read("src/backend/Modules/Endpoints/DistributionEndpoints.cs");
        string readProof = Read("src/backend/Modules/Endpoints/ReadProofEndpoints.cs");
        string pow = Read("src/backend/Infrastructure/Filters/PowValidationLogic.cs");

        Assert.Contains("AddEndpointFilter<RiskAwarePublicReadFilter>()", comments, StringComparison.Ordinal);
        Assert.Contains("RequireRateLimiting(\"public_read\")", taxonomy, StringComparison.Ordinal);
        Assert.Contains("AddEndpointFilter<RiskAwarePublicReadFilter>()", distribution, StringComparison.Ordinal);
        Assert.Contains("RequireRateLimiting(\"read_proof\")", readProof, StringComparison.Ordinal);
        Assert.Contains("CrawlerRiskReason.ReadProofRejected", readProof, StringComparison.Ordinal);
        Assert.Contains("CrawlerRiskReason.PowInvalid", pow, StringComparison.Ordinal);
    }

    [Fact]
    public void DistributionResources_UseCdnFriendlyCacheAndExplicitRobotsPolicy()
    {
        string endpoints = Read("src/backend/Modules/Endpoints/DistributionEndpoints.cs");
        string service = Read("src/backend/Services/Distribution/BlogDistributionService.cs");

        Assert.DoesNotContain("no-cache", endpoints, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("stale-while-revalidate=300", endpoints, StringComparison.Ordinal);
        Assert.Contains("Headers.ETag", endpoints, StringComparison.Ordinal);
        Assert.Contains("Status304NotModified", endpoints, StringComparison.Ordinal);
        Assert.Contains("Disallow: /api/", service, StringComparison.Ordinal);
        Assert.Contains("Allow: /api/public/", service, StringComparison.Ordinal);
        Assert.Contains("Disallow: /search/index.bin", service, StringComparison.Ordinal);
        Assert.Contains("Disallow: /search/patches/", service, StringComparison.Ordinal);
    }

    private static string Read(string relativePath)
        => File.ReadAllText(Path.Combine(RepoRoot, relativePath));

    private static string ResolveRepoRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "FsusBlog.slnx")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Unable to locate repository root.");
    }
}
