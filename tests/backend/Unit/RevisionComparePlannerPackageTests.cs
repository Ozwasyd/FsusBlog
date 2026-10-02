using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionComparePlannerTests
{
    [Theory]
    [InlineData(null, "N")]
    [InlineData("", "S")]
    [InlineData("null", "Snull")]
    [InlineData("N", "SN")]
    [InlineData("S", "SS")]
    [InlineData("Snull", "SSnull")]
    [InlineData("Nnull", "SNnull")]
    [InlineData("\"null\"", "S\"null\"")]
    [InlineData("\\u006eull", "S\\u006eull")]
    [InlineData("\0\r\n", "S\0\r\n")]
    [InlineData("👩‍🔬中文", "S👩‍🔬中文")]
    public void NullableString_UsesExactTypedTagsAndRoundTrips(string? raw, string canonical)
    {
        foreach (string fieldId in new[] { "summary", "cover-image-url" })
        {
            RevisionCompareMetadataValue value = RevisionCompareMetadataRegistry.NullableString(fieldId, raw);

            Assert.Equal(canonical, value.CanonicalValue);
            Assert.Equal(raw, RevisionCompareMetadataRegistry.DecodeNullableString(value));
            Assert.Equal(RevisionCompareMetadataValueType.NullableString, value.ValueType);
            Assert.True(RevisionCompareMetadataRegistry.TryGet(fieldId, out RevisionCompareMetadataDescriptor descriptor));
            Assert.Equal("nullable-string-tagged-utf8-v2", descriptor.Normalization);
        }
    }

    [Fact]
    public void NullableString_DistinctTypedInputsProduceDistinctSealedPackageDigests()
    {
        string?[] inputs = [null, "", "null", "N", "S", "Snull", "Nnull", "\"null\"", "\\u006eull", "\0", "é", "e\u0301", "👩‍🔬"];
        RevisionComparePackage[] packages = inputs.Select(raw => PackageWithSummary(raw)).ToArray();

        Assert.Equal(inputs.Length, packages.Select(static package => package.PackageDigest).Distinct().Count());
        Assert.All(packages, static package => Assert.True(RevisionComparePackageSeal.Verify(package)));
        Assert.All(packages, static package => Assert.Equal(2, package.SchemaVersion));
        foreach (string? input in inputs)
        {
            Assert.Equal(PackageWithSummary(input).PackageDigest, PackageWithSummary(input).PackageDigest);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("null")]
    [InlineData("Nnull")]
    [InlineData("N\0")]
    [InlineData("Xtext")]
    public void PackageSeal_RejectsMalformedNullableCanonicalValues(string? canonical)
    {
        var value = new RevisionCompareMetadataValue("summary", RevisionCompareMetadataValueType.NullableString, canonical!, false);

        Assert.Throws<RevisionCompareContractException>(() => RevisionCompareMetadataRegistry.DecodeNullableString(value));
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
                [value],
                Snapshots()));

        Assert.Equal("revision_compare_metadata_invalid", error.Code);
    }

    [Theory]
    [InlineData(0xd800)]
    [InlineData(0xdc00)]
    public void NullableString_RejectsInvalidUnicodeBeforeEncoding(int codeUnit)
    {
        string raw = new((char)codeUnit, 1);
        RevisionCompareContractException error = Assert.Throws<RevisionCompareContractException>(() =>
            RevisionCompareMetadataRegistry.NullableString("summary", raw));

        Assert.Equal("revision_compare_metadata_invalid", error.Code);
        Assert.Throws<RevisionCompareContractException>(() => PackageWithSummaryCanonical("S" + raw));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NullableString_PreservesLogical8192BudgetThroughSealVerifyAndPlanner(bool supplementaryUnicode)
    {
        string raw = supplementaryUnicode
            ? string.Concat(Enumerable.Repeat("😀", RevisionCompareContract.MaxMetadataValueLength / 2))
            : new string('x', RevisionCompareContract.MaxMetadataValueLength);
        RevisionComparePackage baseline = PackageWithSummary(raw);
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : current)));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(Request());
        RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(reader).VerifyAsync(
            result.Bundle!,
            DateTimeOffset.UtcNow);

        Assert.Equal(8_192, raw.Length);
        Assert.Equal(8_193, baseline.Metadata.Single(static value => value.FieldId == "summary").CanonicalValue.Length);
        Assert.True(RevisionComparePackageSeal.Verify(baseline));
        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.True(RevisionComparePlanVerifier.LocalBundleValid(result.Bundle!));
        Assert.True(verification.Valid, verification.ReasonCode);
    }

    [Fact]
    public void NullableString_RejectsLogical8193InFactoryAndDirectMetadataWithoutWideningOtherTypes()
    {
        string raw = new('x', RevisionCompareContract.MaxMetadataValueLength + 1);

        Assert.Throws<RevisionCompareContractException>(() => RevisionCompareMetadataRegistry.NullableString("summary", raw));
        Assert.Throws<RevisionCompareContractException>(() => PackageWithSummaryCanonical("S" + raw));
        Assert.Throws<RevisionCompareContractException>(() => RevisionCompareMetadataRegistry.String("title", raw));
        Assert.Equal(8_192, RevisionCompareMetadataRegistry.String("title", raw[..^1]).CanonicalValue.Length);
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
            sealedPackage.SchemaVersion,
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

    private static RevisionComparePackage PackageWithSummary(string? raw)
        => PackageWithSummaryCanonical(RevisionCompareMetadataRegistry.NullableString("summary", raw).CanonicalValue);

    private static RevisionComparePackage PackageWithSummaryCanonical(string canonical)
        => RevisionComparePackageSeal.Create(
            7,
            RevisionCompareSourceKind.HistoricalRevision,
            "revision:11",
            11,
            1,
            null,
            null,
            Encoding.UTF8.GetBytes("base"),
            Metadata().Select(value => value.FieldId == "summary" ? value with { CanonicalValue = canonical } : value),
            Snapshots());
}
