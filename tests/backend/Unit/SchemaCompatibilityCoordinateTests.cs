using System.Globalization;

using FsusBlog.Migration;
using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SchemaCompatibilityCoordinateTests
{
    [Fact]
    public void ReleaseCoordinates_OrderByCanonicalUtcTimestamp()
    {
        HistoricalMigrationFence earlier = Coordinate("20260719235959-ffffffffffff");
        HistoricalMigrationFence later = Coordinate("20260720000000-000000000000");

        Assert.True(earlier.CompareTo(later) < 0);
    }

    [Fact]
    public void SameSecondSha_OrderIsDeterministicButCarriesNoPublicationTimeMeaning()
    {
        HistoricalMigrationFence shaA = Coordinate("20260720000000-000000000001");
        HistoricalMigrationFence shaB = Coordinate("20260720000000-ffffffffffff");

        Assert.True(shaA.CompareTo(shaB) < 0);
        Assert.Equal(0, shaA.CompareTo(Coordinate(shaA.Value)));
    }

    [Fact]
    public void CanonicalSentinelsBoundReleaseCoordinates()
    {
        HistoricalMigrationFence release = Coordinate("20260720000000-aaaaaaaaaaaa");

        Assert.True(HistoricalMigrationFence.Minimum.CompareTo(release) < 0);
        Assert.True(HistoricalMigrationFence.Maximum.CompareTo(release) > 0);
    }

    [Theory]
    [InlineData("20260720-release")]
    [InlineData("20260720000000-AAAAAAAAAAAA")]
    [InlineData("2026072000000-aaaaaaaaaaaa")]
    [InlineData("not-a-coordinate")]
    public void ManifestRejectsNonCanonicalCoordinates(string value)
        => Assert.Throws<ArgumentException>(() => ReleaseId.Parse(value));

    [Theory]
    [InlineData(HistoricalMigrationFence.MinimumValue)]
    [InlineData(HistoricalMigrationFence.MaximumValue)]
    [InlineData("20260720-online-migration-gate")]
    public void DeploymentReleaseIdRejectsSchemaFences(string value)
        => Assert.Throws<ArgumentException>(() => ReleaseId.Parse(value));

    [Fact]
    public void LegacyAdapterPreservesHistoricalValueWithoutForgingReleaseIdentity()
    {
        const string LegacyValue = "20260711-online-migration-gate";

        HistoricalMigrationFence coordinate =
            HistoricalMigrationFence.FromLegacyMetadata(LegacyValue);

        Assert.True(coordinate.IsLegacy);
        Assert.Equal(LegacyValue, coordinate.Value);
        Assert.Throws<ArgumentException>(() => ReleaseId.Parse(coordinate.Value));
    }

    [Fact]
    public void ComparisonIsIndependentOfCurrentCultureAndTimezone()
    {
        HistoricalMigrationFence left = Coordinate("20260720000000-aaaaaaaaaaaa");
        HistoricalMigrationFence right = Coordinate("20260720000000-bbbbbbbbbbbb");
        int invariant = left.CompareTo(right);
        CultureInfo originalCulture = CultureInfo.CurrentCulture;
        CultureInfo originalUiCulture = CultureInfo.CurrentUICulture;

        try
        {
            CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("tr-TR");
            CultureInfo.CurrentUICulture = CultureInfo.GetCultureInfo("tr-TR");

            Assert.Equal(invariant, left.CompareTo(right));
        }
        finally
        {
            CultureInfo.CurrentCulture = originalCulture;
            CultureInfo.CurrentUICulture = originalUiCulture;
        }
    }

    [Theory]
    [InlineData("20260230-invalid-date")]
    [InlineData("20260720-UPPERCASE")]
    [InlineData("not-a-historical-fence")]
    [InlineData("20260720-valid-fence ")]
    [InlineData("20260720-valid-fence\n")]
    [InlineData("20260720-valid-fence\r\n")]
    public void HistoricalFence_RejectsCorruptLegacyScalars(string value)
        => Assert.Throws<ArgumentException>(() => HistoricalMigrationFence.FromLegacyMetadata(value));

    [Theory]
    [InlineData("20260720-valid-fence", "20260720000000-000000000000~legacy~valid-fence")]
    [InlineData("20240229-leap-day", "20240229000000-000000000000~legacy~leap-day")]
    public void HistoricalFence_PreservesValidHistoricalDateAndSuffix(string value, string expectedSortKey)
    {
        HistoricalMigrationFence fence = HistoricalMigrationFence.FromLegacyMetadata(value);

        Assert.True(fence.IsLegacy);
        Assert.Equal(value, fence.Value);
        Assert.Equal(expectedSortKey, fence.SortKey);
    }

    [Theory]
    [InlineData("", "")]
    [InlineData(" value", " value")]
    [InlineData("value", "different")]
    public void RecordedHistoricalValue_RequiresExplicitMatchingSortKey(string value, string key)
        => Assert.Throws<ArgumentException>(() => HistoricalMigrationFence.FromRecordedValue(value, key));

    private static HistoricalMigrationFence Coordinate(string value)
    {
        ReleaseId recorded = ReleaseId.Parse(value);
        return HistoricalMigrationFence.FromRecordedValue(recorded.Value, recorded.Value);
    }
}
