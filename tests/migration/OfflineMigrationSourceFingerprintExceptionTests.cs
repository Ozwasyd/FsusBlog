using System.Collections.Immutable;
using System.Text.Json;

using FsusBlog.Contracts.Migration;

using Xunit;

namespace FsusBlog.Migration.Tests;

// Pure exact-difference/terminal projection fixtures, not native provider cleanup proof.
public sealed class OfflineMigrationSourceFingerprintExceptionTests
{
    [Fact]
    public void UnknownSchemaPreservesExactMissingExtraChangedWithoutRawText()
    {
        OfflineMigrationSourceShape expected = Shape() with
        {
            Schema = [new("missing-private-name", "private-secret-a"), new("changed", "private-secret-b")]
        };
        OfflineMigrationSourceShape actual = expected with
        {
            Schema = [new("changed", "private-secret-c"), new("extra-private-name", "private-secret-d")]
        };
        OfflineMigrationSourceFingerprintException error = Unknown(expected, actual);
        Assert.Equal("source_fingerprint_unknown", error.Code);
        Assert.Equal(error.Code, error.Message);
        Assert.Null(error.InnerException);
        Assert.Empty(error.AmbiguousBaselineIdSha256s);
        Assert.Equal(3, error.Differences.Length);
        foreach (OfflineMigrationFingerprintDifference difference in error.Differences)
        {
            Assert.Equal(OfflineMigrationFingerprintCategory.Schema, difference.Category);
            Assert.Equal(2, difference.ExpectedFactCount);
            Assert.Equal(2, difference.ActualFactCount);
            Assert.Equal(Hash("private-baseline"), difference.BaselineIdSha256);
        }
        OfflineMigrationFingerprintDifference missing = Assert.Single(error.Differences,
            value => value.Kind == OfflineMigrationFingerprintDifferenceKind.Missing);
        Assert.Equal(Hash("missing-private-name"), missing.FactNameSha256);
        Assert.Equal(Hash("private-secret-a"), missing.ExpectedValueSha256);
        Assert.Null(missing.ActualValueSha256);
        OfflineMigrationFingerprintDifference extra = Assert.Single(error.Differences,
            value => value.Kind == OfflineMigrationFingerprintDifferenceKind.Extra);
        Assert.Null(extra.ExpectedValueSha256);
        Assert.Equal(Hash("private-secret-d"), extra.ActualValueSha256);
        OfflineMigrationFingerprintDifference changed = Assert.Single(error.Differences,
            value => value.Kind == OfflineMigrationFingerprintDifferenceKind.Changed);
        Assert.Equal(Hash("private-secret-b"), changed.ExpectedValueSha256);
        Assert.Equal(Hash("private-secret-c"), changed.ActualValueSha256);
        string transport = Serialize(error);
        Assert.DoesNotContain("private-", transport, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData(OfflineMigrationFingerprintCategory.History)]
    [InlineData(OfflineMigrationFingerprintCategory.Business)]
    public void HistoryAndBusinessAreCompleteSeparateCategories(OfflineMigrationFingerprintCategory category)
    {
        OfflineMigrationSourceShape expected = Shape() with
        {
            History = [new("history.state", "absent")],
            BusinessShape = [new("overflow", "0")]
        };
        OfflineMigrationSourceShape actual = category == OfflineMigrationFingerprintCategory.History
            ? expected with
            {
                History = [new("history.state", "partial")]
            }
            : expected with
            {
                BusinessShape = [new("overflow", "1")]
            };
        OfflineMigrationFingerprintDifference difference = Assert.Single(Unknown(expected, actual).Differences);
        Assert.Equal(category, difference.Category);
        Assert.Equal(OfflineMigrationFingerprintDifferenceKind.Changed, difference.Kind);
        Assert.Equal(1, difference.ExpectedFactCount);
        Assert.Equal(1, difference.ActualFactCount);
    }

    [Fact]
    public void ExtractorIdentityDifferencesAreNotLostOrGuessedFromMessages()
    {
        OfflineMigrationSourceShape expected = Shape();
        OfflineMigrationSourceFingerprintException error = Unknown(expected,
            expected with
            {
                ExtractorId = "other",
                ExtractorVersion = "2"
            });
        Assert.Equal(2, error.Differences.Length);
        Assert.All(error.Differences, difference => Assert.Equal(OfflineMigrationFingerprintCategory.Extractor, difference.Category));
        Assert.Contains(error.Differences, difference => difference.FactNameSha256 == Hash("id"));
        Assert.Contains(error.Differences, difference => difference.FactNameSha256 == Hash("version"));
    }

    [Fact]
    public void CanonicalOrderingPreservesEveryBaselineAndDoesNotSelectNearest()
    {
        OfflineMigrationSourceShape expected = Shape() with
        {
            Schema = [new("b", "0"), new("a", "0")]
        };
        OfflineMigrationSourceShape actual = expected with
        {
            Schema = [new("a", "1"), new("b", "1")]
        };
        OfflineMigrationSourceFingerprintException one = OfflineMigrationSourceFingerprintException.Unknown(
            [("second", expected), ("first", expected)], actual);
        OfflineMigrationSourceFingerprintException two = OfflineMigrationSourceFingerprintException.Unknown(
            [("first", expected with { Schema = expected.Schema.Reverse().ToImmutableArray() }), ("second", expected)], actual);
        Assert.Equal(Serialize(one), Serialize(two));
        Assert.Equal(4, one.Differences.Length);
        Assert.Equal(2, one.Differences.Select(value => value.BaselineIdSha256).Distinct().Count());
    }

    [Fact]
    public void AmbiguousCarriesAllHashedMatchesWithoutTurningThemIntoUnknownOrSelection()
    {
        OfflineMigrationSourceFingerprintException error = OfflineMigrationSourceFingerprintException.Ambiguous(["private-two", "private-one"]);
        Assert.Equal("source_fingerprint_ambiguous", error.Code);
        Assert.Empty(error.Differences);
        Assert.Equal(new[] { Hash("private-one"), Hash("private-two") }.OrderBy(value => value, StringComparer.Ordinal),
            error.AmbiguousBaselineIdSha256s);
        Assert.DoesNotContain("private-", Serialize(error), StringComparison.Ordinal);
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceFingerprintException.Ambiguous(["one"]));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceFingerprintException.Ambiguous(["same", "same"]));
    }

    [Fact]
    public void UnobservedDuplicateOrAlreadyMatchedShapesCannotFabricateUnknownDiff()
    {
        OfflineMigrationSourceShape shape = Shape();
        Assert.Throws<InvalidOperationException>(() => Unknown(shape, shape));
        Assert.Throws<InvalidOperationException>(() => Unknown(shape, shape with { History = default }));
        Assert.Throws<InvalidOperationException>(() => Unknown(shape, shape with { Schema = [new("same", "1"), new("same", "2")] }));
        Assert.Throws<InvalidOperationException>(() => OfflineMigrationSourceFingerprintException.Unknown([], shape));
    }

    [Fact]
    public void TextHashPreservesEmptyNulUnpairedSurrogatesAndBufferBoundaries()
    {
        string[] values = ["", "\0", "x", "x\0", "\ud800", "\ud801", "\ufffd", new('x', 256), new('x', 257)];
        Assert.Equal(values.Length, values.Select(Hash).Distinct().Count());
        Assert.All(values, value => Assert.Matches("^[0-9a-f]{64}$", Hash(value)));
        Assert.Equal(Hash("\ud800"), Hash(new string(new[] { '\ud800' })));
    }

    [Fact]
    public void KnownSchemaRefusalUsesTheRealClosedRegistryShapesAndSafeTransport()
    {
        ImmutableArray<OfflineMigrationFact> actual = OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.PostgreSql, false)
            .Add(new("table/private-password", "private-sql-default"));
        OfflineMigrationSourceFingerprintException error = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.PostgreSql, actual));
        Assert.Equal(2, error.Differences.Select(value => value.BaselineIdSha256).Distinct().Count());
        Assert.All(error.Differences, value => Assert.Equal(OfflineMigrationFingerprintCategory.Schema, value.Category));
        Assert.DoesNotContain("private-", Serialize(error), StringComparison.Ordinal);
        Assert.False(OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.PostgreSql,
            OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.PostgreSql, false)));
    }

    [Fact]
    public void ActualTerminalProjectionPropagatesOnlyTypedSafeFailureAfterCleanupReturned()
    {
        OfflineMigrationSourceFingerprintException original = Unknown(Shape(), Shape() with
        {
            Schema = [new("extra", "secret")]
        });
        OfflineMigrationSourceFingerprintException error = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationPostgreSqlNativeSession.ThrowAfterCleanup(original, Returned, Returned, Returned, CancellationToken.None));
        Assert.Same(original, error);
        InvalidOperationException generic = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationPostgreSqlNativeSession.ThrowAfterCleanup(new InvalidOperationException("source_fingerprint_unknown:secret"),
                Returned, Returned, Returned, CancellationToken.None));
        Assert.Equal("offline_source_native_operation_failed", generic.Message);
        Assert.Null(generic.InnerException);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    public void CleanupUnverifiedTakesPriorityOverTypedPayloadAndCancellation(int resource)
    {
        OfflineMigrationSourceFingerprintException original = Unknown(Shape(), Shape() with
        {
            Schema = [new("extra", "secret")]
        });
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var states = new[] { Returned, Returned, Returned };
        states[resource] = OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationPostgreSqlNativeSession.ThrowAfterCleanup(original, states[0], states[1], states[2], cancellation.Token));
        Assert.StartsWith("offline_source_native_cleanup_unverified_primary_source_fingerprint_unknown", error.Message, StringComparison.Ordinal);
        Assert.Null(error.InnerException);
        Assert.DoesNotContain("secret", error.Message, StringComparison.Ordinal);
    }

    private const OfflineMigrationPostgreSqlNativeSession.CleanupState Returned = OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned;

    private static OfflineMigrationSourceShape Shape()
        => new(CurrentSchemaProviderKind.PostgreSql, "extractor", "1", [], [], []);

    private static OfflineMigrationSourceFingerprintException Unknown(OfflineMigrationSourceShape expected, OfflineMigrationSourceShape actual)
        => OfflineMigrationSourceFingerprintException.Unknown([("private-baseline", expected)], actual);

    private static string Hash(string value) => OfflineMigrationSourceFingerprintException.HashText(value);

    private static string Serialize(OfflineMigrationSourceFingerprintException error)
        => JsonSerializer.Serialize(new
        {
            error.Code,
            error.Differences,
            error.AmbiguousBaselineIdSha256s
        });
}
