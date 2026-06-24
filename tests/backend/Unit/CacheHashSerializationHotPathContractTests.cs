using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Infrastructure.PublicAot;
using System.Runtime.CompilerServices;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CacheHashSerializationHotPathContractTests
{
    [Fact]
    public void ArticleCoreQueryCache_UsesStableIdentityHelpersWithoutInlineInterpolation()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs");

        Assert.Contains("BuildArticleListIdentity", source, StringComparison.Ordinal);
        Assert.Contains("BuildArticleDetailIdentity", source, StringComparison.Ordinal);
        Assert.Contains("BuildArticleSearchIdentity", source, StringComparison.Ordinal);
        Assert.Contains("string.Create", source, StringComparison.Ordinal);
        Assert.DoesNotContain("string identity = $\"", source, StringComparison.Ordinal);
    }

    [Fact]
    public void ArticleCoreQueryCache_IdentityHelpersPreserveSemanticFormat()
    {
        Assert.Equal(
            "core:v4:public:42:3:20:0:7:0:-1:fsus",
            ArticleCoreQueryCache.BuildArticleListIdentity("public", 42, 3, 20, null, 7, false, null, "fsus"));
        Assert.Equal("core:v3:99", ArticleCoreQueryCache.BuildArticleDetailIdentity(99));
        Assert.Equal("core:v2:keyword", ArticleCoreQueryCache.BuildArticleSearchIdentity("keyword"));
        Assert.Equal("core:v2:12", ArticleCoreQueryCache.BuildHotArticlesBaseIdentity(12));
        Assert.Equal("core:v2:featured:6", ArticleCoreQueryCache.BuildFeaturedArticlesIdentity(6));
    }

    [Fact]
    public void CrawlerDetector_ReusesVerificationCacheKeyOnMissPath()
    {
        string source = ReadRepoFile("src/backend/Services/Security/CrawlerDetectorService.cs");

        Assert.Contains("BuildCrawlerVerificationCacheKey", source, StringComparison.Ordinal);
        Assert.DoesNotContain("$\"crawler:verified:", source, StringComparison.Ordinal);
        Assert.Equal(1, CountOccurrences(source, "string.Concat(\"crawler:verified:\", ipStr)"));
    }

    [Fact]
    public void HexHotPaths_UseLowercaseHexDirectly()
    {
        string[] files =
        [
            "src/backend/Infrastructure/Audit/AuditTamperEvidence.cs",
            "src/backend/Infrastructure/PublicAot/PublicAotHtmlArtifact.cs",
            "src/backend/Modules/Endpoints/SubscriptionEndpoints.cs",
            "src/backend/Services/HumanReadProofService.cs",
            "src/backend/Services/Authoring/AuthoringWorkflowService.cs",
            "src/backend/Services/Moderation/ModerationRuntimeStateService.cs",
            "src/backend/Services/Moderation/ModerationRegionCatalogService.cs",
            "src/backend/Services/Moderation/ModerationDictionaryService.cs",
            "src/backend/Services/Moderation/ClientRegionResolver.cs",
            "src/backend/Services/SearchIndexService.cs",
            "src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs"
        ];

        foreach (string file in files)
        {
            string source = ReadRepoFile(file);
            Assert.DoesNotContain("Convert.ToHexString(SHA256.HashData", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Convert.ToHexString(HMACSHA256.HashData", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Convert.ToHexString(hash).ToLowerInvariant()", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Convert.ToHexString(hash[..8]).ToLowerInvariant()", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Convert.ToHexString(bytes).ToLowerInvariant()", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Convert.ToHexString(value).ToLowerInvariant()", source, StringComparison.Ordinal);
            Assert.DoesNotContain(".AsSpan(0, 16).ToString().ToLowerInvariant()", source, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void ImageHelper_ExtractReferencesUsesRegexEnumeration()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Helpers/ImageHelper.cs");
        string method = ExtractMethodBlock(source, "public static List<IllustrationReference> ExtractIllustrationReferences");

        Assert.Contains("EnumerateMatches", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".Matches(content)", method, StringComparison.Ordinal);
        Assert.DoesNotContain(".Value.Trim()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotBinaryPayload_WritesStringPayloadWithoutTemporaryUtf8Array()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotBinaryPayload.cs");
        string method = ExtractMethodBlock(source, "private void WriteStringPayload");

        Assert.Contains("Encoding.UTF8.GetByteCount", method, StringComparison.Ordinal);
        Assert.Contains("Encoding.UTF8.GetBytes(value.AsSpan()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(value)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotBinaryPayload_RoundTripsStringPayloadsWithoutChangingSemantics()
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["empty"] = string.Empty,
            ["unicode"] = "标题🙂/uploads/illustration/html image.jpg",
            ["nested"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["text"] = "line\nbreak"
            }
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal(string.Empty, decoded["empty"]);
        Assert.Equal("标题🙂/uploads/illustration/html image.jpg", decoded["unicode"]);
        var nested = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(decoded["nested"]);
        Assert.Equal("line\nbreak", nested["text"]);
    }

    [Fact]
    public void PublicAotBinaryPayload_WritesDecimalAsFixedPointBits()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotBinaryPayload.cs");
        string writeDecimal = ExtractMethodBlock(source, "private void WriteDecimal");
        string tryReadDecimal = ExtractMethodBlock(source, "private bool TryReadDecimal");

        Assert.Contains("decimal.GetBits(value)", writeDecimal, StringComparison.Ordinal);
        Assert.DoesNotContain("WriteDouble", writeDecimal, StringComparison.Ordinal);
        Assert.DoesNotContain("(double)", writeDecimal, StringComparison.Ordinal);
        Assert.Contains("new decimal(lo, mid, hi, isNegative, scale)", tryReadDecimal, StringComparison.Ordinal);
        Assert.DoesNotContain("TryReadDouble", tryReadDecimal, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicAotBinaryPayload_RoundTripsDecimalPayloadsWithoutPrecisionDrift()
    {
        const decimal scoreWeight = 0.1234567890123456789012345678m;
        const decimal negativeFloor = -0.0000000000000000000000000001m;
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["scoreWeight"] = scoreWeight,
            ["negativeFloor"] = negativeFloor,
            ["nested"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["max"] = decimal.MaxValue
            }
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal(scoreWeight, Assert.IsType<decimal>(decoded["scoreWeight"]));
        Assert.Equal(negativeFloor, Assert.IsType<decimal>(decoded["negativeFloor"]));
        var nested = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(decoded["nested"]);
        Assert.Equal(decimal.MaxValue, Assert.IsType<decimal>(nested["max"]));
    }

    [Fact]
    public void RumTelemetry_UsesFrozenAllowlistsAndSourceGeneratedJson()
    {
        string source = ReadRepoFile("src/backend/Services/Telemetry/RumTelemetryService.cs");

        Assert.Contains("FrozenSet<string>", source, StringComparison.Ordinal);
        Assert.Contains("JsonSerializable", source, StringComparison.Ordinal);
        Assert.Contains("RumTelemetryJsonContext", source, StringComparison.Ordinal);
        Assert.DoesNotContain("HashSet<string> AllowedNames", source, StringComparison.Ordinal);
        Assert.DoesNotContain("JsonSerializer.Serialize(context.Metrics)", source, StringComparison.Ordinal);
    }

    [Fact]
    public void DistributionAndSubscriptionAvoidManualEtagAndReadThenWrite()
    {
        string distribution = ReadRepoFile("src/backend/Modules/Endpoints/DistributionEndpoints.cs");
        string subscription = ReadRepoFile("src/backend/Modules/Endpoints/SubscriptionEndpoints.cs");

        Assert.DoesNotContain("BuildWeakEtag", distribution, StringComparison.Ordinal);
        Assert.DoesNotContain("IfNoneMatch", distribution, StringComparison.Ordinal);
        Assert.DoesNotContain(".Split(',',", distribution, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (email_hash) DO UPDATE", subscription, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Convert.ToHexStringLower", subscription, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath, [CallerFilePath] string sourceFile = "")
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static int CountOccurrences(string source, string value)
    {
        int count = 0;
        int start = 0;
        while (start < source.Length)
        {
            int index = source.IndexOf(value, start, StringComparison.Ordinal);
            if (index < 0)
            {
                return count;
            }

            count++;
            start = index + value.Length;
        }

        return count;
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
