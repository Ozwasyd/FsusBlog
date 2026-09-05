using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RevisionComparePlannerTests
{
    [Fact]
    public async Task CreateAsync_SealsExactAuthorizedPackagesAndIsDeterministic()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base\r\n");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "next\n");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : current)));
        RevisionComparePlanRequest request = Request();

        RevisionComparePlanResult first = await new RevisionComparePlanner(reader).CreateAsync(request);
        RevisionComparePlanResult second = await new RevisionComparePlanner(reader).CreateAsync(request);

        Assert.True(first.IsSuccess);
        Assert.True(RevisionComparePlanVerifier.LocalBundleValid(first.Bundle!));
        Assert.Equal(first.Bundle!.Plan.ContentDigest, second.Bundle!.Plan.ContentDigest);
        Assert.Equal(baseline.PackageDigest, first.Bundle.Plan.BasePackage.PackageDigest);
        Assert.Equal(current.SourceDigest, first.Bundle.Plan.ComparePackage.SourceDigest);
        Assert.Equal(Encoding.UTF8.GetBytes("base\r\n"), first.Bundle.BasePackage.RawMarkdown);
    }

    [Fact]
    public async Task CreateAsync_UnavailableCompareDoesNotLeakReadableBaseDigest()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "secret");
        int call = 0;
        var reader = new DelegateReader((_, _, _) => Task.FromResult(
            ++call == 1
                ? RevisionComparePackageReadResult.Available(baseline)
                : RevisionComparePackageReadResult.Unavailable()));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(Request());

        Assert.Equal(RevisionComparePlanStatus.Unavailable, result.Status);
        Assert.Null(result.Receipt.BasePackageDigest);
        Assert.Null(result.Receipt.ComparePackageDigest);
        Assert.Null(result.Bundle);
    }

    [Fact]
    public async Task CreateAsync_RejectsLateReaderThatIgnoresCancellation()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        int call = 0;
        var reader = new DelegateReader(async (_, _, _) =>
        {
            if (++call == 2)
            {
                await Task.Delay(40);
            }
            return RevisionComparePackageReadResult.Available(call == 1 ? baseline : current);
        });

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(
            Request() with
            {
                Budgets = Budgets() with
                {
                    TimeoutMilliseconds = 10
                }
            });

        Assert.Equal(RevisionComparePlanStatus.Cancelled, result.Status);
        Assert.Equal("revision_compare_timeout", result.Receipt.ReasonCode);
        Assert.Null(result.Bundle);
    }

    [Fact]
    public async Task CreateAsync_RejectsPlanWhoseDeadlinePassesDuringRead()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        var reader = new DelegateReader(async (_, _, _) =>
        {
            await Task.Delay(30);
            return RevisionComparePackageReadResult.Available(baseline);
        });

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(
            Request() with
            {
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddMilliseconds(10)
            });

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_plan_expired", result.Receipt.ReasonCode);
    }

    [Fact]
    public async Task CreateAsync_AdmitsByteBudgetBeforeLineScan()
    {
        RevisionComparePackage tooLarge = Package(
            RevisionCompareSourceKind.HistoricalRevision,
            11,
            1,
            new string('x', 65));
        RevisionComparePackage current = Package(
            RevisionCompareSourceKind.CurrentRevision,
            12,
            2,
            new string('y', 65));
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? tooLarge : current)));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(
            Request() with
            {
                Budgets = Budgets() with
                {
                    MaxSourceBytes = 64
                }
            });

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_compare_source_budget_exceeded", result.Receipt.ReasonCode);
    }

    [Fact]
    public void PackageSeal_RejectsBeforeCopyingAboveAbsoluteSourceLimit()
    {
        byte[] oversized = new byte[RevisionCompareContract.AbsoluteMaxSourceBytes + 1];

        RevisionCompareContractException error = Assert.Throws<RevisionCompareContractException>(() =>
            RevisionComparePackageSeal.Create(
                7,
                RevisionCompareSourceKind.HistoricalRevision,
                "revision:11",
                11,
                1,
                null,
                null,
                oversized,
                Metadata(),
                Snapshots()));

        Assert.Equal("revision_compare_source_budget_exceeded", error.Code);
    }

    [Fact]
    public async Task VerifyAsync_FailsClosedWhenExactSourceReferenceChanges()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        RevisionComparePackage changed = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "changed");
        bool drifted = false;
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(
                selector.RevisionId == 11 ? baseline : drifted ? changed : current)));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(Request());
        drifted = true;

        RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(reader).VerifyAsync(
            planned.Bundle!,
            DateTimeOffset.UtcNow);

        Assert.False(verification.Valid);
        Assert.Equal(RevisionComparePlanStatus.Stale, verification.Status);
        Assert.Equal("revision_compare_source_stale", verification.ReasonCode);
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

    private static RevisionComparePlanRequest Request()
        => new(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("0f138dd2-9c89-4d89-9e67-ec2c502247ae")),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: 12),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                true,
                ["title", "tag-ids"]),
            Budgets(),
            "compare:7:11:12",
            DateTimeOffset.UtcNow.AddMinutes(5));

    private static RevisionCompareBudgets Budgets()
        => new(1_024, 100, 1_000, 32_768, 1_048_576, 100, 10, 1_000);

    private static RevisionComparePackage Package(
        RevisionCompareSourceKind kind,
        long revisionId,
        int revisionNo,
        string markdown)
        => RevisionComparePackageSeal.Create(
            7,
            kind,
            $"revision:{revisionId}",
            revisionId,
            revisionNo,
            null,
            null,
            Encoding.UTF8.GetBytes(markdown),
            Metadata(),
            Snapshots());

    private static RevisionCompareMetadataValue[] Metadata()
        =>
        [
            RevisionCompareMetadataRegistry.String("title", "Title"),
            RevisionCompareMetadataRegistry.NullableString("summary", null),
            RevisionCompareMetadataRegistry.NullableString("cover-image-url", null),
            RevisionCompareMetadataRegistry.Int32("category-id", 2),
            RevisionCompareMetadataRegistry.Int32List("tag-ids", [3, 1]),
            RevisionCompareMetadataRegistry.Int32("status", 1),
            RevisionCompareMetadataRegistry.NullableInstant("scheduled-publish-at", null)
        ];

    private static RevisionCompareSnapshot[] Snapshots()
        =>
        [
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
        ];

    private sealed class DelegateReader(
        Func<int, RevisionCompareSourceSelector, CancellationToken, Task<RevisionComparePackageReadResult>> read)
        : IRevisionComparePackageReader
    {
        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
            => read(articleId, selector, cancellationToken);
    }
}
