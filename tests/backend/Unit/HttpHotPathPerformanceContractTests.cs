namespace FsusBlog.Server.Tests.Unit;

public sealed class HttpHotPathPerformanceContractTests
{
    [Fact]
    public void RequestAuditContext_UsesGatedDirectScopeAndLowerHexHashing()
    {
        string root = FindRepoRoot();
        string middleware = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/RequestAuditContextMiddleware.cs"));
        string auditRecord = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/AuditRecord.cs"));

        Assert.Contains("ShouldAttachAuditContext", middleware, StringComparison.Ordinal);
        Assert.Contains("PushLogContext", auditRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("new ReadOnlyDictionary", auditRecord, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(value.Trim())", auditRecord, StringComparison.Ordinal);
        Assert.Contains("Convert.ToHexStringLower", auditRecord, StringComparison.Ordinal);
    }

    [Fact]
    public void FastUserIdParsing_UsesRequestItemCacheAndNoSubFallback()
    {
        string root = FindRepoRoot();
        string provider = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/FastUserIdProvider.cs"));
        string extensions = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Helpers/ClaimsPrincipalExtensions.cs"));

        Assert.Contains("ParsedUserIdItemKey", provider, StringComparison.Ordinal);
        Assert.Contains("GetOrParseUserId", provider, StringComparison.Ordinal);
        Assert.DoesNotContain("FindFirst(\"sub\")", extensions, StringComparison.Ordinal);
    }

    [Fact]
    public void PowReplayIdentity_UsesSpanHashingWithoutStringJoinMaterialization()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Services/Security/RedisPowService.cs"));

        Assert.Contains("TryFormatProofIdentity", source, StringComparison.Ordinal);
        Assert.DoesNotContain("string.Join", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(material)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ObservabilityHotPath_UsesFrozenAllowlistAndGatedTraceMaterialization()
    {
        string root = FindRepoRoot();
        string observability = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Observability/FsusObservability.cs"));
        string middleware = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Observability/ObservabilityCorrelationMiddleware.cs"));

        Assert.Contains("FrozenSet<string>", observability, StringComparison.Ordinal);
        Assert.Contains("ToFrozenSet", observability, StringComparison.Ordinal);
        Assert.Contains("ShouldMaterializeTraceId", middleware, StringComparison.Ordinal);
        Assert.DoesNotContain("string traceId = activity.TraceId.ToString();", middleware, StringComparison.Ordinal);
    }

    [Fact]
    public void VisitAndCrawlerHotPaths_AvoidSplitUserAgentJoinAndSmallIpByteArrays()
    {
        string root = FindRepoRoot();
        string httpContextExtensions = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Helpers/HttpContextExtensions.cs"));
        string crawlerDetector = File.ReadAllText(Path.Combine(root, "src/backend/Services/Security/CrawlerDetectorService.cs"));
        string visitLogProcessor = File.ReadAllText(Path.Combine(root, "src/backend/Services/VisitLog/VisitLogProcessorService.cs"));

        Assert.DoesNotContain(".Split(", httpContextExtensions, StringComparison.Ordinal);
        Assert.DoesNotContain("Headers.UserAgent.ToString()", httpContextExtensions, StringComparison.Ordinal);
        Assert.Contains("MaxUserAgentLength", httpContextExtensions, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAddressBytes()", crawlerDetector, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAddressBytes()", visitLogProcessor, StringComparison.Ordinal);
        Assert.Contains("TryWriteBytes", crawlerDetector, StringComparison.Ordinal);
        Assert.Contains("TryWriteBytes", visitLogProcessor, StringComparison.Ordinal);
    }

    private static string FindRepoRoot()
    {
        string current = AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
