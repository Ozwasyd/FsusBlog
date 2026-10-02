using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionComparePlannerTests
{
    [Fact]
    public async Task VerifyAsync_RejectsLegacyV1PackagePlanAndReceiptBeforeAuthorityRead()
    {
        RevisionComparePlanBundle legacy = LegacyV1Bundle();
        var reader = new DelegateReader((_, _, _) => throw new InvalidOperationException("legacy plan must not read authority"));

        Assert.Equal(
            legacy.BasePackage.PackageDigest,
            RevisionCompareCanonical.PackageDigest(
                1,
                legacy.BasePackage.ArticleId,
                legacy.BasePackage.SourceKind,
                legacy.BasePackage.SourceIdentity,
                legacy.BasePackage.RevisionId,
                legacy.BasePackage.RevisionNo,
                legacy.BasePackage.ServerRevision,
                legacy.BasePackage.DocumentEpoch,
                legacy.BasePackage.SourceDigest,
                legacy.BasePackage.RawMarkdown.Length,
                legacy.BasePackage.Metadata,
                legacy.BasePackage.Snapshots));
        Assert.Equal(legacy.Receipt.ContentDigest, RevisionCompareCanonical.ReceiptDigest(legacy.Receipt));
        Assert.False(RevisionComparePackageSeal.Verify(legacy.BasePackage));
        Assert.False(RevisionComparePackageSeal.Verify(legacy.ComparePackage));
        Assert.False(RevisionComparePlanVerifier.LocalBundleValid(legacy));

        RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(reader).VerifyAsync(
            legacy,
            DateTimeOffset.UtcNow);

        Assert.False(verification.Valid);
        Assert.Equal(RevisionComparePlanStatus.Stale, verification.Status);
        Assert.Equal("revision_compare_schema_stale", verification.ReasonCode);

        var engine = new RevisionSourceDiffEngine(
            new RevisionComparePlanVerifier(reader),
            new RevisionMarkdownStructureAuthority([]));
        RevisionSourceDiffResult diff = await engine.ComputeAsync(legacy, DateTimeOffset.UtcNow);

        Assert.False(diff.IsSuccess);
        Assert.Equal(RevisionComparePlanStatus.Stale, diff.Status);
        Assert.Equal("revision_compare_schema_stale", diff.Receipt.ReasonCode);
        Assert.Empty(diff.Chunks);
    }

    [Theory]
    [InlineData("N", "b0dc8f409e4f41be77572852d13683e1eca33f8618a689329c796a0c33767e48")]
    [InlineData("Sfoo", "50ae46d45215062e11841d0d2451dedd814b93b534810db15df9767c088e39c3")]
    public void PackageSeal_RejectsLegacyVersionEvenWhenLiteralValuesLookLikeV2Tags(string literal, string legacyDigest)
    {
        RevisionComparePackage legacy = LegacyV1Bundle().BasePackage;
        var taggedLookingLegacy = new RevisionComparePackage(
            1,
            legacy.ArticleId,
            legacy.SourceKind,
            legacy.SourceIdentity,
            legacy.RevisionId,
            legacy.RevisionNo,
            legacy.ServerRevision,
            legacy.DocumentEpoch,
            legacy.RawMarkdown,
            legacy.SourceDigest,
            [.. legacy.Metadata.Select(value => value.ValueType == RevisionCompareMetadataValueType.NullableString
                ? value with { CanonicalValue = literal }
                : value)],
            legacy.Snapshots,
            legacyDigest);

        Assert.All(
            taggedLookingLegacy.Metadata,
            static value => Assert.True(RevisionCompareMetadataRegistry.ValidCanonicalValue(value.ValueType, value.CanonicalValue)));
        Assert.Equal(
            legacyDigest,
            RevisionCompareCanonical.PackageDigest(
                1,
                legacy.ArticleId,
                legacy.SourceKind,
                legacy.SourceIdentity,
                legacy.RevisionId,
                legacy.RevisionNo,
                legacy.ServerRevision,
                legacy.DocumentEpoch,
                legacy.SourceDigest,
                legacy.RawMarkdown.Length,
                taggedLookingLegacy.Metadata,
                legacy.Snapshots));
        Assert.False(RevisionComparePackageSeal.Verify(taggedLookingLegacy));
    }

    [Fact]
    public async Task VerifyAsync_RejectsLegacyReceiptAndRehashedOldMetadataSchemaOnV2Plan()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : current)));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(Request());
        RevisionComparePlanReceipt legacyReceipt = LegacyV1Bundle().Receipt;
        RevisionComparePlanReceipt rehashedSchema = ResealReceipt(planned.Bundle!.Receipt with
        {
            MetadataSchemaDigest = legacyReceipt.MetadataSchemaDigest
        });
        var noRead = new DelegateReader((_, _, _) => throw new InvalidOperationException("invalid receipt must not read authority"));

        Assert.NotEqual(legacyReceipt.MetadataSchemaDigest, planned.Receipt.MetadataSchemaDigest);
        foreach (RevisionComparePlanReceipt receipt in new[] { legacyReceipt, rehashedSchema })
        {
            RevisionComparePlanBundle tampered = planned.Bundle with { Receipt = receipt };

            Assert.False(RevisionComparePlanVerifier.LocalBundleValid(tampered));
            RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(noRead).VerifyAsync(
                tampered,
                DateTimeOffset.UtcNow);
            Assert.False(verification.Valid);
            Assert.Equal(RevisionComparePlanStatus.Tampered, verification.Status);
            Assert.Equal("revision_compare_plan_tampered", verification.ReasonCode);
        }
    }

    [Fact]
    public async Task VerifyAsync_NullToLiteralNullMetadataDriftIsStaleWithUnchangedMarkdown()
    {
        RevisionComparePackage baseline = PackageWithSummary(null);
        RevisionComparePackage changed = PackageWithSummary("null");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        bool drifted = false;
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? drifted ? changed : baseline : current)));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(Request());
        drifted = true;

        Assert.Equal(baseline.SourceDigest, changed.SourceDigest);
        Assert.NotEqual(baseline.PackageDigest, changed.PackageDigest);
        RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(reader).VerifyAsync(
            planned.Bundle!,
            DateTimeOffset.UtcNow);

        Assert.False(verification.Valid);
        Assert.Equal(RevisionComparePlanStatus.Stale, verification.Status);
        Assert.Equal("revision_compare_source_stale", verification.ReasonCode);
    }

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
        Assert.Equal(first.Bundle.Plan.BasePackage, first.Bundle.Receipt.BasePackageReference);
        Assert.Equal(first.Bundle.Plan.ComparePackage, first.Bundle.Receipt.ComparePackageReference);
        Assert.Equal(first.Bundle.Plan.Admission.ContentDigest, first.Bundle.Receipt.AdmissionDigest);
        Assert.Equal(
            RevisionCompareCanonical.PermissionScopeDigest(request),
            first.Bundle.Receipt.PermissionScopeDigest);
        Assert.Equal(RevisionCompareCanonical.MetadataSchemaDigest(), first.Bundle.Receipt.MetadataSchemaDigest);
        Assert.Equal(RevisionCompareCanonical.OptionsDigest(request.Options), first.Bundle.Receipt.OptionsDigest);
        Assert.Equal(RevisionCompareCanonical.BudgetDigest(request.Budgets), first.Bundle.Receipt.BudgetDigest);
        Assert.Equal(request.Budgets.MaxTokenCount, first.Bundle.Plan.Admission.TokenLimit);
        Assert.Equal(
            request.Budgets.MaxHunksPerChunk * request.Budgets.MaxChunks,
            first.Bundle.Plan.Admission.HunkLimit);
        Assert.Equal(request.Budgets.MaxChunks, first.Bundle.Plan.Admission.ChunkLimit);
    }

    [Fact]
    public async Task CreateAsync_RejectsImpossibleOutputAdmissionBeforeReturningPlan()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base\n");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "next\n");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : current)));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(
            Request() with
            {
                Budgets = Budgets() with
                {
                    MaxOutputBytes = 100
                }
            });

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_compare_output_budget_exceeded", result.Receipt.ReasonCode);
        Assert.Null(result.Bundle);
        Assert.Null(result.Receipt.AdmissionDigest);
    }

    [Fact]
    public async Task CreateAsync_RejectsInvalidTokenHunkAndChunkBudgetsBeforeReadingSources()
    {
        var reader = new DelegateReader((_, _, _) => throw new InvalidOperationException("reader should not run"));
        RevisionCompareBudgets[] invalidBudgets =
        [
            Budgets() with { MaxTokenCount = 0 },
            Budgets() with { MaxHunksPerChunk = 0 },
            Budgets() with { MaxChunks = 0 }
        ];

        foreach (RevisionCompareBudgets budgets in invalidBudgets)
        {
            RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(
                Request() with
                {
                    Budgets = budgets
                });

            Assert.Equal(RevisionComparePlanStatus.Invalid, result.Status);
            Assert.Equal("revision_compare_budget_invalid", result.Receipt.ReasonCode);
            Assert.Null(result.Bundle);
        }
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
        Assert.Null(result.Receipt.BasePackageReference);
        Assert.Null(result.Receipt.ComparePackageReference);
        Assert.Null(result.Receipt.AdmissionDigest);
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
    public async Task CreateAsync_RejectsExpiredPlanBeforeReadingSources()
    {
        var reader = new DelegateReader((_, _, _) =>
            throw new InvalidOperationException("reader should not run"));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(
            Request() with
            {
                ExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1)
            });

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_plan_expired", result.Receipt.ReasonCode);
        Assert.Null(result.Bundle);
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
    public void PackageSeal_CopiesCallerOwnedSourceAndSnapshotPayload()
    {
        byte[] source = Encoding.UTF8.GetBytes("original\n");
        byte[] rights = Encoding.UTF8.GetBytes("sealed-rights");
        RevisionCompareSnapshot[] snapshots =
        [
            RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights, "rights:11", 1, rights),
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
            RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
        ];
        RevisionComparePackage package = RevisionComparePackageSeal.Create(
            7,
            RevisionCompareSourceKind.HistoricalRevision,
            "revision:11",
            11,
            1,
            null,
            null,
            source,
            Metadata(),
            snapshots);

        source[0] = (byte)'X';
        rights[0] = (byte)'X';
        snapshots[0] = RevisionCompareSnapshot.Missing(RevisionCompareSnapshotKind.Rights);

        Assert.Equal("original\n", Encoding.UTF8.GetString(package.RawMarkdown.AsSpan()));
        Assert.Equal(
            "sealed-rights",
            Encoding.UTF8.GetString(package.Snapshots[0].Payload.AsSpan()));
        Assert.True(RevisionComparePackageSeal.Verify(package));
    }

    [Fact]
    public async Task CreateAsync_PropagatesReaderBoundaryBudgetWithoutSourceReceiptLeak()
    {
        var reader = new DelegateReader((_, _, _) => Task.FromResult(
            RevisionComparePackageReadResult.BudgetExceeded()));

        RevisionComparePlanResult result = await new RevisionComparePlanner(reader).CreateAsync(Request());

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_compare_source_budget_exceeded", result.Receipt.ReasonCode);
        Assert.Null(result.Receipt.BasePackageDigest);
        Assert.Null(result.Receipt.ComparePackageDigest);
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
    public async Task VerifyAsync_RejectsRehashedReceiptBindingTamper()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : current)));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(Request());
        RevisionComparePlanReceipt receipt = planned.Bundle!.Receipt;
        RevisionComparePlanReceipt[] tamperedReceipts =
        [
            receipt with { SchemaVersion = receipt.SchemaVersion + 1 },
            receipt with { RequestId = Guid.Parse("9e8be2c4-fb3b-4af7-9a8e-e632c181583e") },
            receipt with { ReasonCode = "accepted-rehashed" },
            receipt with { BasePackageDigest = receipt.ComparePackageDigest },
            receipt with { ComparePackageDigest = receipt.BasePackageDigest },
            receipt with { BasePackageReference = receipt.ComparePackageReference },
            receipt with { ComparePackageReference = receipt.BasePackageReference },
            receipt with { PermissionScopeDigest = new string('a', 64) },
            receipt with { MetadataSchemaDigest = new string('b', 64) },
            receipt with { OptionsDigest = new string('c', 64) },
            receipt with { BudgetDigest = new string('d', 64) },
            receipt with { AdmissionDigest = new string('e', 64) },
            receipt with { CancellationIdentity = "compare:7:rehashed" }
        ];

        foreach (RevisionComparePlanReceipt tamperedReceipt in tamperedReceipts)
        {
            RevisionComparePlanBundle tampered = planned.Bundle with
            {
                Receipt = ResealReceipt(tamperedReceipt)
            };

            Assert.False(RevisionComparePlanVerifier.LocalBundleValid(tampered));
        }
    }

    [Fact]
    public async Task VerifyAsync_ReappliesRehashedPlanBudget()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(selector.RevisionId == 11 ? baseline : current)));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(Request());
        RevisionComparePlan plan = ResealPlan(
            planned.Bundle!.Plan,
            planned.Bundle.Plan.Budgets with
            {
                MaxSourceBytes = 4
            });
        RevisionComparePlanReceipt receipt = ResealReceipt(planned.Bundle.Receipt with
        {
            PlanDigest = plan.ContentDigest,
            BudgetDigest = RevisionCompareCanonical.BudgetDigest(plan.Budgets),
            AdmissionDigest = plan.Admission.ContentDigest
        });
        var tampered = new RevisionComparePlanBundle(
            plan,
            planned.Bundle.BasePackage,
            planned.Bundle.ComparePackage,
            receipt);

        RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(reader).VerifyAsync(
            tampered,
            DateTimeOffset.UtcNow);

        Assert.False(verification.Valid);
        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, verification.Status);
        Assert.Equal("revision_compare_source_budget_exceeded", verification.ReasonCode);
    }

    [Fact]
    public async Task VerifyAsync_RejectsTamperedFreshPackageWithMatchingReference()
    {
        RevisionComparePackage baseline = Package(RevisionCompareSourceKind.HistoricalRevision, 11, 1, "base");
        RevisionComparePackage current = Package(RevisionCompareSourceKind.CurrentRevision, 12, 2, "current");
        var tamperedCurrent = new RevisionComparePackage(
            current.SchemaVersion,
            current.ArticleId,
            current.SourceKind,
            current.SourceIdentity,
            current.RevisionId,
            current.RevisionNo,
            current.ServerRevision,
            current.DocumentEpoch,
            [.. Encoding.UTF8.GetBytes("CURRENT")],
            current.SourceDigest,
            current.Metadata,
            current.Snapshots,
            current.PackageDigest);
        bool tampered = false;
        var reader = new DelegateReader((_, selector, _) => Task.FromResult(
            RevisionComparePackageReadResult.Available(
                selector.RevisionId == 11 ? baseline : tampered ? tamperedCurrent : current)));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(Request());
        tampered = true;

        RevisionComparePlanVerification verification = await new RevisionComparePlanVerifier(reader).VerifyAsync(
            planned.Bundle!,
            DateTimeOffset.UtcNow);

        Assert.False(verification.Valid);
        Assert.Equal(RevisionComparePlanStatus.Tampered, verification.Status);
        Assert.Equal("revision_compare_package_tampered", verification.ReasonCode);
    }

    private static RevisionComparePlanBundle LegacyV1Bundle()
    {
        // Fixed vectors follow b19b3dc7's v1 canonical append order and original
        // nullable values; they are not v2 digests with a relabeled header.
        RevisionComparePlanRequest request = Request() with
        {
            ExpiresAtUtc = new DateTimeOffset(2100, 1, 1, 0, 0, 0, TimeSpan.Zero)
        };
        RevisionComparePackage baseline = LegacyV1Package(
            RevisionCompareSourceKind.HistoricalRevision,
            11,
            1,
            "base",
            "7c736967eabb7e2430bf88870397b25ea5877fe40152f839517afed5493043b5");
        RevisionComparePackage current = LegacyV1Package(
            RevisionCompareSourceKind.CurrentRevision,
            12,
            2,
            "current",
            "477a9136f740f0ddbb62e0bf9ba932abd9fe2d1f67a6ed1efe9b80ebd4cd281c");
        RevisionComparePackageReference baseReference = RevisionCompareCanonical.Reference(baseline);
        RevisionComparePackageReference compareReference = RevisionCompareCanonical.Reference(current);
        var admission = new RevisionCompareAdmission(
            RevisionCompareAdmissionMode.BoundedWorkerChunksV1,
            4,
            7,
            1,
            1,
            172,
            96,
            1_000,
            1_000,
            10,
            "2a4892568519c297252096fa72b70f1567169f69a31b6b8b928643b22b84a186");
        const string PlanDigest = "9b375f0bada07c54ae71dabf4edb9e7c99681911d5bf40d69673d7636d8f2a51";
        var plan = new RevisionComparePlan(
            1,
            "revision-compare-plan-v1",
            request.ArticleId,
            request.Reader,
            request.Base,
            request.Compare,
            baseReference,
            compareReference,
            request.Options,
            request.Budgets,
            admission,
            request.CancellationIdentity,
            request.ExpiresAtUtc,
            PlanDigest);
        var receipt = new RevisionComparePlanReceipt(
            1,
            request.Reader.RequestId,
            RevisionComparePlanStatus.Accepted,
            "accepted",
            PlanDigest,
            baseline.PackageDigest,
            current.PackageDigest,
            baseReference,
            compareReference,
            "a71bfac8cf53df1f00d09d331fe50d268b2a6d2c77c07dde2a12babbf8a0be49",
            "7030b53cea5556cf2bf37182d9e035be50076d4f9b1f9317a35c0fbbefeb4245",
            "57dd22b783d9cd9c9c61253cf12ba34317c696132e1954838e642c6fa672098a",
            "1b4ac8c8b4bc4e2186830ef85915218e4f9c6d4653a8bba4c1fb3bd5fc1e8637",
            admission.ContentDigest,
            request.CancellationIdentity,
            "9861809fde91068672c7c5499651310754de87329650d3950f732f9883aa1672");
        return new RevisionComparePlanBundle(plan, baseline, current, receipt);
    }

    private static RevisionComparePackage LegacyV1Package(
        RevisionCompareSourceKind kind,
        long revisionId,
        int revisionNo,
        string source,
        string packageDigest)
    {
        byte[] raw = Encoding.UTF8.GetBytes(source);
        RevisionCompareMetadataValue[] metadata =
        [
            new("title", RevisionCompareMetadataValueType.String, "Title", false),
            new("summary", RevisionCompareMetadataValueType.NullableString, "null", false),
            new("cover-image-url", RevisionCompareMetadataValueType.NullableString, "null", false),
            new("category-id", RevisionCompareMetadataValueType.Int32, "2", false),
            new("tag-ids", RevisionCompareMetadataValueType.Int32List, "1,3", false),
            new("status", RevisionCompareMetadataValueType.Int32, "1", false),
            new("scheduled-publish-at", RevisionCompareMetadataValueType.NullableInstant, "null", false)
        ];
        return new RevisionComparePackage(
            1,
            7,
            kind,
            $"revision:{revisionId}",
            revisionId,
            revisionNo,
            null,
            null,
            [.. raw],
            RevisionCompareCanonical.Sha256(raw),
            [.. metadata.OrderBy(static value => value.FieldId, StringComparer.Ordinal)],
            [.. Snapshots()],
            packageDigest);
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

    private static RevisionComparePlan ResealPlan(
        RevisionComparePlan plan,
        RevisionCompareBudgets budgets)
    {
        var request = new RevisionComparePlanRequest(
            plan.ArticleId,
            plan.Reader,
            plan.BaseSelector,
            plan.CompareSelector,
            plan.Options,
            budgets,
            plan.CancellationIdentity,
            plan.ExpiresAtUtc);
        string contentDigest = RevisionCompareCanonical.PlanDigest(
            request,
            plan.BasePackage,
            plan.ComparePackage,
            ResealAdmission(plan.Admission, budgets));
        return new RevisionComparePlan(
            plan.SchemaVersion,
            plan.PlannerVersion,
            plan.ArticleId,
            plan.Reader,
            plan.BaseSelector,
            plan.CompareSelector,
            plan.BasePackage,
            plan.ComparePackage,
            plan.Options,
            budgets,
            ResealAdmission(plan.Admission, budgets),
            plan.CancellationIdentity,
            plan.ExpiresAtUtc,
            contentDigest);
    }

    private static RevisionCompareAdmission ResealAdmission(
        RevisionCompareAdmission admission,
        RevisionCompareBudgets budgets)
    {
        int hunkLimit = checked(budgets.MaxHunksPerChunk * budgets.MaxChunks);
        return admission with
        {
            TokenLimit = budgets.MaxTokenCount,
            HunkLimit = hunkLimit,
            ChunkLimit = budgets.MaxChunks,
            ContentDigest = RevisionCompareCanonical.AdmissionDigest(
                admission.Mode,
                admission.BaseSourceByteCount,
                admission.CompareSourceByteCount,
                admission.BaseLineCount,
                admission.CompareLineCount,
                admission.InitialEstimatedMemoryBytes,
                admission.MinimumEstimatedOutputBytes,
                budgets.MaxTokenCount,
                hunkLimit,
                budgets.MaxChunks)
        };
    }

    private static RevisionComparePlanReceipt ResealReceipt(RevisionComparePlanReceipt receipt)
        => receipt with
        {
            ContentDigest = RevisionCompareCanonical.ReceiptDigest(receipt)
        };

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

    private static RevisionComparePackage DraftPackage(string epoch, long serverRevision, string markdown)
        => RevisionComparePackageSeal.Create(
            7,
            RevisionCompareSourceKind.CurrentDraft,
            $"draft:5:draft-key:{serverRevision}:{epoch}",
            null,
            null,
            serverRevision,
            epoch,
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
