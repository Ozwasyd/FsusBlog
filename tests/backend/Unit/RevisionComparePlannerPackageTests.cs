using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionComparePlannerTests
{
    [Fact]
    public void MetadataRegistry_PreservesNullEmptyAndLiteralNullAsDistinctPackages()
    {
        RevisionCompareMetadataValue absent = RevisionCompareMetadataRegistry.NullableString("summary", null);
        RevisionCompareMetadataValue empty = RevisionCompareMetadataRegistry.NullableString("summary", "");
        RevisionCompareMetadataValue literal = RevisionCompareMetadataRegistry.NullableString("summary", "null");
        RevisionCompareMetadataValue escaped = RevisionCompareMetadataRegistry.NullableString("summary", "\"\\\n中文");

        Assert.Equal("null", absent.CanonicalValue);
        Assert.Equal("\"\"", empty.CanonicalValue);
        Assert.Equal("\"null\"", literal.CanonicalValue);
        Assert.Equal("\"\\\n中文", System.Text.Json.JsonSerializer.Deserialize<string>(escaped.CanonicalValue));
        Assert.Equal(4, new[] { absent, empty, literal, escaped }.Select(value =>
            RevisionComparePackageSeal.Create(7, RevisionCompareSourceKind.HistoricalRevision, "revision:11", 11, 1,
                null, null, Encoding.UTF8.GetBytes("body"), [value], Snapshots()).PackageDigest).Distinct().Count());
    }

    [Theory]
    [InlineData("summary", RevisionCompareMetadataValueType.NullableString, "not-json")]
    [InlineData("summary", RevisionCompareMetadataValueType.NullableString, "123")]
    [InlineData("summary", RevisionCompareMetadataValueType.NullableString, " null ")]
    [InlineData("category-id", RevisionCompareMetadataValueType.Int32, "01")]
    [InlineData("category-id", RevisionCompareMetadataValueType.Int32, "2147483648")]
    [InlineData("tag-ids", RevisionCompareMetadataValueType.Int32List, "1,1")]
    [InlineData("tag-ids", RevisionCompareMetadataValueType.Int32List, "2,1")]
    [InlineData("tag-ids", RevisionCompareMetadataValueType.Int32List, "0,1")]
    [InlineData("status", RevisionCompareMetadataValueType.Int32, "5")]
    [InlineData("status", RevisionCompareMetadataValueType.Int32, "-1")]
    [InlineData("scheduled-publish-at", RevisionCompareMetadataValueType.NullableInstant, "2026-01-01T00:00:00.0000000")]
    public void PackageSeal_RejectsNoncanonicalTypedValues(string fieldId,
        RevisionCompareMetadataValueType valueType, string canonicalValue)
    {
        var value = new RevisionCompareMetadataValue(fieldId, valueType, canonicalValue, false);

        RevisionCompareContractException error = Assert.Throws<RevisionCompareContractException>(() =>
            RevisionComparePackageSeal.Create(7, RevisionCompareSourceKind.HistoricalRevision, "revision:11", 11, 1,
                null, null, Encoding.UTF8.GetBytes("body"), [value], Snapshots()));

        Assert.Equal("revision_compare_metadata_invalid", error.Code);
    }

    [Fact]
    public void MetadataRegistry_RejectsDuplicateTagsAndUndefinedStatusWithoutChangingValidValues()
    {
        Assert.Equal("1,3", RevisionCompareMetadataRegistry.Int32List("tag-ids", [3, 1]).CanonicalValue);
        Assert.Equal("", RevisionCompareMetadataRegistry.Int32List("tag-ids", []).CanonicalValue);
        Assert.Throws<RevisionCompareContractException>(() => RevisionCompareMetadataRegistry.Int32List("tag-ids", [1, 1]));
        Assert.Throws<RevisionCompareContractException>(() => RevisionCompareMetadataRegistry.Int32List("tag-ids", [0]));
        Assert.Throws<RevisionCompareContractException>(() => RevisionCompareMetadataRegistry.Int32("status", 5));
        for (int status = 0; status <= 4; status++)
        {
            Assert.Equal(status.ToString(System.Globalization.CultureInfo.InvariantCulture),
                RevisionCompareMetadataRegistry.Int32("status", status).CanonicalValue);
        }
        var utc = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        Assert.Equal(RevisionCompareMetadataRegistry.NullableInstant("scheduled-publish-at", utc),
            RevisionCompareMetadataRegistry.NullableInstant("scheduled-publish-at", DateTime.SpecifyKind(utc, DateTimeKind.Unspecified)));
    }

    [Fact]
    public async Task CreateAsync_RejectsUnknownMetadataFieldWithoutReadingSources()
    {
        var reader = new DelegateReader((_, _, _) => throw new InvalidOperationException("reader should not run"));
        RevisionComparePlanRequest request = Request() with
        {
            Options = new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                true,
                ["unknown"])
        };

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(request);

        Assert.Equal(RevisionComparePlanStatus.Invalid, result.Status);
        Assert.Equal("revision_compare_metadata_field_unknown", result.Receipt.ReasonCode);
    }

    [Fact]
    public async Task CreateAsync_RejectsCrossArticlePackageFromAuthorityBoundary()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage crossArticle = RevisionComparePackageSeal.Create(
            8,
            RevisionCompareSourceKind.CurrentRevision,
            "revision:12",
            12,
            2,
            null,
            null,
            Encoding.UTF8.GetBytes("other"),
            Metadata(),
            Snapshots());
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : crossArticle)));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(Request());

        Assert.Equal(RevisionComparePlanStatus.Invalid, result.Status);
        Assert.Equal("revision_compare_cross_article_invalid", result.Receipt.ReasonCode);
    }

    [Fact]
    public async Task CreateAsync_RejectsMissingSnapshotWithoutInventingFallback()
    {
        RevisionComparePackage incomplete = RevisionComparePackageSeal.Create(
            7,
            RevisionCompareSourceKind.HistoricalRevision,
            "revision:11",
            11,
            1,
            null,
            null,
            Encoding.UTF8.GetBytes("base"),
            Metadata(),
            [
                RevisionCompareSnapshot.Missing(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? incomplete : current)));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(Request());

        Assert.Equal(RevisionComparePlanStatus.Invalid, result.Status);
        Assert.Equal("revision_compare_package_incomplete", result.Receipt.ReasonCode);
    }

    [Fact]
    public async Task CreateAsync_RejectsTamperedRawBytesAndSeal()
    {
        RevisionComparePackage sealedPackage = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        var tampered = new RevisionComparePackage(
            sealedPackage.ArticleId,
            sealedPackage.SourceKind,
            sealedPackage.SourceIdentity,
            sealedPackage.RevisionId,
            sealedPackage.RevisionNo,
            sealedPackage.ServerRevision,
            sealedPackage.DocumentEpoch,
            [.. Encoding.UTF8.GetBytes("tampered")],
            sealedPackage.SourceDigest,
            sealedPackage.Metadata,
            sealedPackage.Snapshots,
            sealedPackage.PackageDigest);
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? tampered : current)));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(Request());

        Assert.Equal(RevisionComparePlanStatus.Tampered, result.Status);
        Assert.Equal("revision_compare_package_tampered", result.Receipt.ReasonCode);
    }

    [Fact]
    public void PackageSeal_RejectsDuplicateTypedMetadata()
    {
        RevisionCompareMetadataValue title = RevisionCompareMetadataRegistry.String("title", "Title");

        RevisionCompareContractException error = Assert.Throws<RevisionCompareContractException>(() =>
            RevisionComparePackageSeal.Create(
                7,
                RevisionCompareSourceKind.HistoricalRevision,
                "revision:11",
                11,
                1,
                null,
                null,
                Encoding.UTF8.GetBytes("base"),
                [title, title],
                Snapshots()));

        Assert.Equal("revision_compare_metadata_invalid", error.Code);
    }

    [Fact]
    public void PackageSeal_RejectsUnknownSnapshotKind()
    {
        RevisionCompareSnapshot[] snapshots = Snapshots();
        snapshots[2] = RevisionCompareSnapshot.NotApplicable((RevisionCompareSnapshotKind)int.MaxValue);

        RevisionCompareContractException error = Assert.Throws<RevisionCompareContractException>(() =>
            RevisionComparePackageSeal.Create(
                7,
                RevisionCompareSourceKind.HistoricalRevision,
                "revision:11",
                11,
                1,
                null,
                null,
                Encoding.UTF8.GetBytes("base"),
                Metadata(),
                snapshots));

        Assert.Equal("revision_compare_snapshot_set_invalid", error.Code);
    }

    [Fact]
    public async Task CreateAsync_AdmitsDraftAgainstHistoricalWithExactEpochAndSourceRevision()
    {
        RevisionComparePackage draft = DraftPackage("epoch-a", 4, "draft body");
        RevisionComparePackage historical = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "history");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(
                selector.Kind == RevisionCompareSourceKind.CurrentDraft ? draft : historical)));
        RevisionComparePlanRequest request = Request() with
        {
            Base = new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 4,
                DocumentEpoch: "epoch-a"),
            Compare = new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11)
        };

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(request);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Equal("epoch-a", result.Bundle!.Plan.BasePackage.DocumentEpoch);
        Assert.Equal(4, result.Bundle.Plan.BasePackage.ServerRevision);
    }

    [Fact]
    public async Task CreateAsync_AdmitsTwoHistoricalPackagesWithoutCurrentPointerLookup()
    {
        RevisionComparePackage first = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "one");
        RevisionComparePackage second = Package(RevisionCompareSourceKind.HistoricalRevision, 12, 2, "two");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? first : second)));
        RevisionComparePlanRequest request = Request() with
        {
            Compare = new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 12)
        };

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(request);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.All(
            [result.Bundle!.Plan.BasePackage, result.Bundle.Plan.ComparePackage],
            static package => Assert.Equal(RevisionCompareSourceKind.HistoricalRevision, package.SourceKind));
    }

    [Fact]
    public async Task CreateAsync_RejectsDraftEpochOrSourceRevisionDrift()
    {
        RevisionComparePackage draft = DraftPackage("epoch-b", 5, "changed");
        RevisionComparePackage historical = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "history");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(
                selector.Kind == RevisionCompareSourceKind.CurrentDraft ? draft : historical)));
        RevisionComparePlanRequest request = Request() with
        {
            Base = new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 4,
                DocumentEpoch: "epoch-a"),
            Compare = new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11)
        };

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(request);

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_source_stale", result.Receipt.ReasonCode);
    }
}
