using System.Collections.Immutable;
using System.Text.Json;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// Exercises the real Host failure serializer and closed matcher, not native execution.
public sealed class OfflineMigrationFingerprintCommandTests
{
    [Theory]
    [InlineData(OfflineMigrationFingerprintCategory.Schema)]
    [InlineData(OfflineMigrationFingerprintCategory.History)]
    [InlineData(OfflineMigrationFingerprintCategory.Business)]
    [InlineData(OfflineMigrationFingerprintCategory.Extractor)]
    public void HostPreservesExactRedactedDifferencesWithoutHistoricalText(OfflineMigrationFingerprintCategory category)
    {
        const string SensitiveName = "unknown-password-field";
        const string SensitiveValue = "historical-private-value";
        var expected = Shape();
        OfflineMigrationSourceShape actual = category switch
        {
            OfflineMigrationFingerprintCategory.Schema => expected with { Schema = [new(SensitiveName, SensitiveValue)] },
            OfflineMigrationFingerprintCategory.History => expected with { History = [new(SensitiveName, SensitiveValue)] },
            OfflineMigrationFingerprintCategory.Business => expected with { BusinessShape = [new(SensitiveName, SensitiveValue)] },
            OfflineMigrationFingerprintCategory.Extractor => expected with { ExtractorVersion = SensitiveValue },
            _ => throw new InvalidOperationException()
        };
        OfflineMigrationSourceFingerprintException failure = OfflineMigrationSourceFingerprintException.Unknown(
            [("private-baseline", expected)], actual);
        using var output = new StringWriter();
        OfflineMigrationHost.WriteFingerprintFailure(failure, output);
        string json = output.ToString();
        using JsonDocument document = JsonDocument.Parse(json);
        JsonElement root = document.RootElement;
        Assert.Equal("failed", root.GetProperty("status").GetString());
        Assert.Equal(failure.Code, root.GetProperty("code").GetString());
        Assert.Equal(JsonSerializer.Serialize(failure.Differences), root.GetProperty("differences").GetRawText());
        Assert.Empty(root.GetProperty("ambiguousBaselineIdSha256s").EnumerateArray());
        Assert.Contains(failure.Differences, difference => difference.Category == category);
        Assert.DoesNotContain(SensitiveName, json, StringComparison.Ordinal);
        Assert.DoesNotContain(SensitiveValue, json, StringComparison.Ordinal);
        Assert.DoesNotContain("private-baseline", json, StringComparison.Ordinal);
        Assert.Equal(new[] { "status", "code", "differences", "ambiguousBaselineIdSha256s" },
            root.EnumerateObject().Select(property => property.Name));
    }

    [Fact]
    public void HostReportsEveryAmbiguousIdentityWithoutSelectingOrPublishingRawIds()
    {
        OfflineMigrationSourceFingerprintException failure = OfflineMigrationSourceFingerprintException.Ambiguous(
            ["private-baseline-one", "private-baseline-two"]);
        using var output = new StringWriter();
        OfflineMigrationHost.WriteFingerprintFailure(failure, output);
        using JsonDocument document = JsonDocument.Parse(output.ToString());
        JsonElement root = document.RootElement;
        Assert.Equal("failed", root.GetProperty("status").GetString());
        Assert.Equal("source_fingerprint_ambiguous", root.GetProperty("code").GetString());
        Assert.Empty(root.GetProperty("differences").EnumerateArray());
        Assert.Equal(failure.AmbiguousBaselineIdSha256s,
            root.GetProperty("ambiguousBaselineIdSha256s").EnumerateArray().Select(value => value.GetString()));
        Assert.DoesNotContain("private-baseline", output.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void UnverifiedIssuerCleanupDoesNotBecomeOrdinaryFingerprintFailure()
    {
        OfflineMigrationSourceFingerprintException failure = OfflineMigrationSourceFingerprintException.Unknown(
            [("original", Shape())], Shape() with
            {
                Schema = [new("changed", "private")]
            });
        failure.Data["current_verify_read_only_cleanup_failed"] = true;
        InvalidOperationException cleanup = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationOwnedVerifyEvidence.ThrowObservedFailure(failure));
        Assert.Equal("current_verify_transaction_cleanup_unverified_primary_failed", cleanup.Message);
        Assert.IsNotType<OfflineMigrationSourceFingerprintException>(cleanup);
    }

    private static OfflineMigrationSourceShape Shape()
        => new(CurrentSchemaProviderKind.PostgreSql, "original-extractor", "1",
            ImmutableArray<OfflineMigrationFact>.Empty, ImmutableArray<OfflineMigrationFact>.Empty,
            ImmutableArray<OfflineMigrationFact>.Empty);
}
