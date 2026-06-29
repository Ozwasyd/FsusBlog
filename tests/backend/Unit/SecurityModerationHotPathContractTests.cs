using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityModerationHotPathContractTests
{
    [Fact]
    public void ModernAcAutomaton_UsesLocalThreadScratchWithoutSharedScanEpoch()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Helpers/Security/ModernAcAutomaton.cs");

        Assert.Contains("[ThreadStatic]", source, StringComparison.Ordinal);
        Assert.Contains("t_ruleRemainingScratch", source, StringComparison.Ordinal);
        Assert.Contains("t_touchedRuleScratch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("_scanEpoch", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Interlocked.Increment", source, StringComparison.Ordinal);
        Assert.DoesNotContain("NextScanEpoch", source, StringComparison.Ordinal);
    }

    [Fact]
    public void TextNormalizer_NormalizeCommonPathCreatesOnlyResultString()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/Helpers/Security/TextNormalizer.cs");
        string normalizeMethod = ExtractBetween(source, "public static string Normalize(string value", "return NormalizeWithPhraseRoot");

        Assert.Contains("string.Create", normalizeMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("ToCharArray()", normalizeMethod, StringComparison.Ordinal);
        Assert.DoesNotContain("new string(buffer)", normalizeMethod, StringComparison.Ordinal);
    }

    [Fact]
    public void CrawlerDetector_NormalizesUserAgentOnceAndAvoidsIpByteArrayAllocation()
    {
        string source = ReadRepoFile("src/backend/Services/Security/CrawlerDetectorService.cs");
        string method = ExtractBetween(source, "public async Task<bool> IsVerifiedCrawlerAsync", "private static IpRadixTree BuildTree");

        Assert.Contains("NormalizeCrawlerUserAgent", source, StringComparison.Ordinal);
        Assert.Contains("normalizedUserAgent", method, StringComparison.Ordinal);
        Assert.DoesNotContain("StringComparison.OrdinalIgnoreCase", method, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAddressBytes()", source, StringComparison.Ordinal);
        Assert.Contains("TryWriteBytes", source, StringComparison.Ordinal);
    }

    [Fact]
    public void SecurityAdminPolicy_UsesBoundedRingAndSinglePassOverviewAggregation()
    {
        string source = ReadRepoFile("src/backend/Services/Security/SecurityAdminPolicyService.cs");

        Assert.Contains("RiskEventRingBuffer", source, StringComparison.Ordinal);
        Assert.Contains("BuildRiskOverviewCounters", source, StringComparison.Ordinal);
        Assert.DoesNotContain("RemoveRange(0", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".GroupBy(", source, StringComparison.Ordinal);
    }

    [Fact]
    public void MfaFailureCounters_UseAtomicSnapshotAndHashIdentityIsSpanBased()
    {
        string source = ReadRepoFile("src/backend/Services/Security/MfaChallengeService.cs");
        string recordFailure = ExtractBetween(source, "public async Task<bool> RecordFailureAsync", "public async Task<string> CreateProofTokenAsync");
        string hashIdentity = ExtractBetween(source, "private static string HashIdentity", "private static byte[] Base64UrlDecode");

        Assert.Contains("IncrementManyWithExpiryAsync", recordFailure, StringComparison.Ordinal);
        Assert.Contains("FailureWindowTtl", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("long ticketFailures = await cache.IncrementAsync", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.WhenAll", recordFailure, StringComparison.Ordinal);
        Assert.DoesNotContain("Encoding.UTF8.GetBytes(value.Trim())", hashIdentity, StringComparison.Ordinal);
        Assert.Contains("Convert.ToHexStringLower", hashIdentity, StringComparison.Ordinal);
    }

    [Fact]
    public void ContentFilterReload_AvoidsDictionaryCopyingAndUsesFrozenCategories()
    {
        string source = ReadRepoFile("src/backend/Services/Security/ContentFilterService.cs");

        Assert.Contains("FrozenSet<string>", source, StringComparison.Ordinal);
        Assert.Contains("EstimateDictionaryLineCapacity", source, StringComparison.Ordinal);
        Assert.DoesNotContain("return [.. lines];", source, StringComparison.Ordinal);
        Assert.DoesNotContain("[term.Value, .. term.Aliases]", source, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractBetween(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }
}
