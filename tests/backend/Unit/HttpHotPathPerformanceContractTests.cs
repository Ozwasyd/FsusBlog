using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class HttpHotPathPerformanceContractTests
{
    [Fact]
    public void RequestAuditContext_UsesGatedDirectScopeAndLowerHexHashing()
    {
        string middleware = ReadRepoFile("src/backend/Infrastructure/Audit/RequestAuditContextMiddleware.cs");
        string auditRecord = ReadRepoFile("src/backend/Infrastructure/Audit/AuditRecord.cs");

        Assert.Contains("ShouldAttachAuditContext", middleware, StringComparison.Ordinal);
        Assert.Contains("PushLogContext", auditRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("new ReadOnlyDictionary", auditRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(value.Trim())", auditRecord, StringComparison.Ordinal);
        Assert.Contains("Convert.ToHexStringLower", auditRecord, StringComparison.Ordinal);
    }

    [Fact]
    public void FastUserIdParsing_UsesRequestItemCacheAndNoSubFallback()
    {
        string provider = ReadRepoFile("src/backend/Infrastructure/FastUserIdProvider.cs");
        string extensions = ReadRepoFile("src/backend/Infrastructure/Helpers/ClaimsPrincipalExtensions.cs");

        Assert.Contains("ParsedUserIdItemKey", provider, StringComparison.Ordinal);
        Assert.Contains("GetOrParseUserId", provider, StringComparison.Ordinal);
        Assert.DoesNotContain("FindFirst(\"sub\")", extensions, StringComparison.Ordinal);
    }

    [Fact]
    public void PowReplayIdentity_UsesSpanHashingWithoutStringJoinMaterialization()
    {
        string source = ReadRepoFile("src/backend/Services/Security/RedisPowService.cs");
        string verify = ExtractBetween(source, "public async Task<bool> VerifyAsync", "public async Task<PowChallenge> GenerateChallengeAsync");
        string identity = ExtractBetween(source, "private static string BuildProofIdentity", "private static TimeSpan ResolveReplayTtl");

        Assert.Contains("byte[] signatureHash = new byte[32]", verify, StringComparison.Ordinal);
        Assert.Contains("BasicValidate(req, clientIp, normalizedBindingContext, signatureHash)", verify, StringComparison.Ordinal);
        Assert.Contains("TryConsumeProofOnceAsync(req, clientIp, signatureHash)", verify, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Join", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(material)", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SHA256.HashData", identity, StringComparison.Ordinal);
        Assert.Contains("Convert.ToHexString(signatureHash)", identity, StringComparison.Ordinal);
    }

    [Fact]
    public void ObservabilityHotPath_UsesFrozenAllowlistAndGatedTraceMaterialization()
    {
        string observability = ReadRepoFile("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string middleware = ReadRepoFile("src/backend/Infrastructure/Observability/ObservabilityCorrelationMiddleware.cs");

        Assert.Contains("FrozenSet<string>", observability, StringComparison.Ordinal);
        Assert.Contains("ToFrozenSet", observability, StringComparison.Ordinal);
        Assert.Contains("ShouldMaterializeTraceId", middleware, StringComparison.Ordinal);
        Assert.DoesNotContain("string traceId = activity.TraceId.ToString();", middleware, StringComparison.Ordinal);
    }

    [Fact]
    public void VisitAndCrawlerHotPaths_AvoidSplitUserAgentJoinAndSmallIpByteArrays()
    {
        string httpContextExtensions = ReadRepoFile("src/backend/Infrastructure/Helpers/HttpContextExtensions.cs");
        string crawlerDetector = ReadRepoFile("src/backend/Services/Security/CrawlerDetectorService.cs");
        string visitLogProcessor = ReadRepoFile("src/backend/Services/VisitLog/VisitLogProcessorService.cs");

        Assert.DoesNotContain(".Split(", httpContextExtensions, StringComparison.Ordinal);
        Assert.DoesNotContain("Headers.UserAgent.ToString()", httpContextExtensions, StringComparison.Ordinal);
        Assert.Contains("MaxUserAgentLength", httpContextExtensions, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAddressBytes()", crawlerDetector, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAddressBytes()", visitLogProcessor, StringComparison.Ordinal);
        Assert.Contains("TryWriteBytes", crawlerDetector, StringComparison.Ordinal);
        Assert.Contains("TryWriteBytes", visitLogProcessor, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
    {
        string fullPath = BackendTestPaths.FromRoot(relativePath);
        Assert.True(File.Exists(fullPath), $"{relativePath} must exist.");
        return File.ReadAllText(fullPath);
    }

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Could not find start marker '{start}'.");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Could not find end marker '{end}'.");
        return source[startIndex..endIndex];
    }
}
