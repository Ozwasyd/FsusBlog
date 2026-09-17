using System.Globalization;

using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.SchemaMigration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SchemaCompatibilityCoordinateTests
{
    [Fact]
    public void ReleaseCoordinates_OrderByCanonicalUtcTimestamp()
    {
        SchemaCompatibilityCoordinate earlier = Coordinate("20260719235959-ffffffffffff");
        SchemaCompatibilityCoordinate later = Coordinate("20260720000000-000000000000");

        Assert.True(earlier.CompareTo(later) < 0);
    }

    [Fact]
    public void SameSecondSha_OrderIsDeterministicButCarriesNoPublicationTimeMeaning()
    {
        SchemaCompatibilityCoordinate shaA = Coordinate("20260720000000-000000000001");
        SchemaCompatibilityCoordinate shaB = Coordinate("20260720000000-ffffffffffff");

        Assert.True(shaA.CompareTo(shaB) < 0);
        Assert.Equal(0, shaA.CompareTo(Coordinate(shaA.Value)));
    }

    [Fact]
    public void CanonicalSentinelsBoundReleaseCoordinates()
    {
        SchemaCompatibilityCoordinate release = Coordinate("20260720000000-aaaaaaaaaaaa");

        Assert.True(SchemaCompatibilityCoordinate.Minimum.CompareTo(release) < 0);
        Assert.True(SchemaCompatibilityCoordinate.Maximum.CompareTo(release) > 0);
    }

    [Theory]
    [InlineData("20260720-release")]
    [InlineData("20260720000000-AAAAAAAAAAAA")]
    [InlineData("2026072000000-aaaaaaaaaaaa")]
    [InlineData("not-a-coordinate")]
    public void ManifestRejectsNonCanonicalCoordinates(string value)
        => Assert.Throws<ArgumentException>(() => SchemaCompatibilityCoordinate.ParseManifest(value));

    [Theory]
    [InlineData(SchemaCompatibilityCoordinate.MinimumValue)]
    [InlineData(SchemaCompatibilityCoordinate.MaximumValue)]
    [InlineData("20260720-online-migration-gate")]
    public void DeploymentReleaseIdRejectsSchemaFences(string value)
        => Assert.Throws<ArgumentException>(() => ReleaseId.Parse(value));

    [Fact]
    public void LegacyAdapterPreservesHistoricalValueWithoutForgingReleaseIdentity()
    {
        const string LegacyValue = "20260711-online-migration-gate";

        SchemaCompatibilityCoordinate coordinate =
            SchemaCompatibilityCoordinate.FromLegacyMetadata(LegacyValue);

        Assert.True(coordinate.IsLegacy);
        Assert.Equal(LegacyValue, coordinate.Value);
        Assert.Throws<ArgumentException>(() => ReleaseId.Parse(coordinate.Value));
    }

    [Fact]
    public void ComparisonIsIndependentOfCurrentCultureAndTimezone()
    {
        SchemaCompatibilityCoordinate left = Coordinate("20260720000000-aaaaaaaaaaaa");
        SchemaCompatibilityCoordinate right = Coordinate("20260720000000-bbbbbbbbbbbb");
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

    private static SchemaCompatibilityCoordinate Coordinate(string value)
        => SchemaCompatibilityCoordinate.FromReleaseId(ReleaseId.Parse(value));
}
