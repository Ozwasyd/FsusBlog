using System.Collections.Immutable;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RevisionMetadataDiffEngineTests
{
    [Fact]
    public async Task ComputeAsync_ProducesTypedStableFieldsAndExplicitPartialCoverage()
    {
        RevisionComparePackage before = Package(11, "old", null, [1, 3]);
        RevisionComparePackage after = Package(12, "new", "", [2, 3]);
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(before, after);
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));

        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Assert.True(result.IsReviewable);
        Assert.False(result.IsSuccess);
        Assert.Equal(RevisionMetadataDiffCoverage.PartialMissingAuthority, result.Receipt.Coverage);
        Assert.Contains("cover_asset_id_missing_authority", result.Receipt.MissingAuthorities);
        Assert.Contains("historical_lifecycle_missing_authority", result.Receipt.MissingAuthorities);
        Assert.Equal("old", Field(result, "title").Before.Text);
        Assert.Equal("new", Field(result, "title").After.Text);
        Assert.Equal(RevisionMetadataDiffValueKind.Null, Field(result, "summary").Before.Kind);
        Assert.Equal("", Field(result, "summary").After.Text);
        Assert.Equal(RevisionMetadataDiffChangeKind.Added, Field(result, "summary").Change);
        Assert.Equal(new[] { 2 }, Field(result, "tag-ids").AddedIds);
        Assert.Equal(new[] { 1 }, Field(result, "tag-ids").RemovedIds);
        Assert.Equal(RevisionMetadataDiffChangeKind.SetChanged, Field(result, "tag-ids").Change);
        Assert.Equal(1, Field(result, "category-id").Before.Number);
        Assert.True(await new RevisionMetadataDiffVerifier(engine).VerifyAsync(bundle, result, DateTimeOffset.UtcNow));
    }

    [Fact]
    public async Task ComputeAsync_UsesTypedSnapshotFieldsRatherThanSerializedBlobOrder()
    {
        RevisionComparePackage before = Package(11, "same", "same", [3, 1]);
        RevisionComparePackage after = Package(12, "same", "same", [1, 3], rights: Rights() with
        {
            CopyrightHolder = "changed",
            MaxExcerptChars = 42,
            AllowCodeCopy = false
        }, responsibility: Responsibility() with
        {
            Methodology = "new method"
        });
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(before, after);
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));

        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Assert.True(result.IsReviewable);
        Assert.Equal(RevisionMetadataDiffChangeKind.Unchanged, Field(result, "tag-ids").Change);
        Assert.Equal("changed", Field(result, "rights.copyright-holder").After.Text);
        Assert.Equal(42, Field(result, "rights.max-excerpt-chars").After.Number);
        Assert.False(Field(result, "rights.allow-code-copy").After.Boolean);
        Assert.Equal("new method", Field(result, "responsibility.methodology").After.Text);
        Assert.Equal(RevisionMetadataDiffValueKind.UtcTicks, Field(result, "release.published-at").After.Kind);
        Assert.Equal(RevisionMetadataDiffValueKind.DateDayNumber, Field(result, "responsibility.sources.0.accessed-on").After.Kind);
        Assert.True(Field(result, "responsibility.sources.0.url").Sensitive);
        Assert.DoesNotContain(result.Fields, static field => field.FieldId.Contains("payload", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ComputeAsync_SemanticDigestIsDeterministicAndTimingIsSeparate()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        RevisionMetadataDiffResult first = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
        RevisionMetadataDiffResult second = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Assert.Equal(first.Receipt.ContentDigest, second.Receipt.ContentDigest);
        Assert.True(first.Timing.ElapsedTicks >= 0);
        Assert.True(second.Timing.ElapsedTicks >= 0);
        Assert.Equal(System.Diagnostics.Stopwatch.Frequency, first.Timing.Frequency);
        Assert.True(await new RevisionMetadataDiffVerifier(engine).VerifyAsync(bundle,
            first with
            {
                Timing = new(0, 1)
            }, DateTimeOffset.UtcNow));
    }

    [Fact]
    public async Task ComputeAsync_TagIdentityUsesNumericIdsRatherThanLabelsOrOrder()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(
            Package(11, tags: [10, 2]), Package(12, tags: [2, 11], category: 2));
        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Assert.Equal(new[] { 2, 10 }, Field(result, "tag-ids").Before.Ids);
        Assert.Equal(new[] { 11 }, Field(result, "tag-ids").AddedIds);
        Assert.Equal(new[] { 10 }, Field(result, "tag-ids").RemovedIds);
        Assert.Equal(RevisionMetadataDiffChangeKind.Replaced, Field(result, "category-id").Change);
    }

    [Fact]
    public async Task ComputeAsync_DraftStatusAndScheduleUseClosedEnumAndUtcTicks()
    {
        DateTime scheduled = new(2026, 1, 1, 12, 0, 0, DateTimeKind.Utc);
        RevisionComparePackage Draft(long serverRevision, int status, DateTime? due)
            => RevisionComparePackageSeal.Create(7, RevisionCompareSourceKind.CurrentDraft, $"draft:{serverRevision}",
                null, null, serverRevision, $"epoch:{serverRevision}", Encoding.UTF8.GetBytes("draft"),
                Metadata("draft", null, [1], 1).Concat([
                    RevisionCompareMetadataRegistry.Int32("status", status),
                    RevisionCompareMetadataRegistry.NullableInstant("scheduled-publish-at", due)]),
                [RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights, $"draft-rights:1:key:{serverRevision}", 1,
                    JsonSerializer.SerializeToUtf8Bytes(new ArticleRightsRequest())),
                 RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                 RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)]);
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Draft(1, 0, null), Draft(2, 1, scheduled),
            fields: ["status", "scheduled-publish-at"]);

        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Assert.Equal(0, Field(result, "status").Before.Number);
        Assert.Equal(1, Field(result, "status").After.Number);
        Assert.Equal(scheduled.Ticks, Field(result, "scheduled-publish-at").After.Number);
        Assert.Equal(RevisionMetadataDiffValueKind.UtcTicks, Field(result, "scheduled-publish-at").After.Kind);
        Assert.DoesNotContain("historical_lifecycle_missing_authority", result.Receipt.MissingAuthorities);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("missing")]
    [InlineData("duplicate")]
    [InlineData("bad-identity")]
    [InlineData("bad-hash")]
    public async Task ComputeAsync_RejectsResealedSnapshotShapeMutations(string mutation)
    {
        string json = JsonSerializer.Serialize(Rights());
        json = mutation switch
        {
            "unknown" => json.Insert(1, "\"Unexpected\":true,"),
            "missing" => json.Replace("\"Enabled\":true,", "", StringComparison.Ordinal),
            "duplicate" => json.Insert(1, "\"Enabled\":false,"),
            "bad-identity" => json.Replace("\"Id\":\"101\"", "\"Id\":\"00101\"", StringComparison.Ordinal),
            "bad-hash" => json.Replace(new string('a', 64), "rights-v3:policy-hash:recompute", StringComparison.Ordinal),
            _ => throw new InvalidOperationException()
        };
        RevisionCompareSnapshot[] snapshots = Snapshots(Rights(), Responsibility(), Release());
        snapshots[0] = RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights, "rights:101", 1, Encoding.UTF8.GetBytes(json));
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12, snapshots: snapshots));

        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Refused(result, RevisionMetadataDiffStatus.Invalid);
    }

    [Fact]
    public async Task ComputeAsync_RevokedPermissionAfterWorkerPublishesNoFieldOrCount()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        reader.Reads = 0;
        reader.FailAt = 3;

        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Refused(result, RevisionMetadataDiffStatus.Stale);
        Assert.DoesNotContain("private source", JsonSerializer.Serialize(result), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ComputeAsync_AlreadyCancelledDoesNotReadPermissionsOrReturnFields()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        reader.Reads = 0;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow, cancellation.Token);

        Refused(result, RevisionMetadataDiffStatus.Cancelled);
        Assert.Equal(0, reader.Reads);
    }

    [Fact]
    public async Task ComputeAsync_TimeoutBoundsAReaderThatNeverAcknowledgesCancellation()
    {
        (RevisionComparePlanBundle bundle, _) = await Plan(Package(11), Package(12),
            budgets: Budgets() with
            {
                TimeoutMilliseconds = 100
            });
        var blocked = new NeverReturningReader();
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(blocked));

        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow)
            .WaitAsync(TimeSpan.FromSeconds(5));

        Refused(result, RevisionMetadataDiffStatus.Cancelled);
        Assert.Equal("metadata_diff_timeout", result.Receipt.Reason);
        Assert.Equal(1, blocked.Reads);
    }

    [Fact]
    public async Task ComputeAsync_LargeSnapshotSetsAreBoundedWithoutPartialOutput()
    {
        ArticleRevisionResponsibilitySnapshotResponse large = Responsibility() with
        {
            Sources = Enumerable.Range(0, 512).Select(index => new ArticleEvidenceSource(
                "source " + index, "https://example.test/" + index, "paper", null, null, null, false)).ToArray()
        };
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11),
            Package(12, responsibility: large), budgets: Budgets() with
            {
                MaxOutputBytes = 10_000
            });

        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
    }

    [Fact]
    public async Task ComputeAsync_StalePackageAndExpiredPlanReturnNoPartialSuccess()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        reader.After = Package(12, "drifted");
        Refused(await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow), RevisionMetadataDiffStatus.Stale);
        Refused(await engine.ComputeAsync(bundle, bundle.Plan.ExpiresAtUtc.AddTicks(1)), RevisionMetadataDiffStatus.Stale);
    }

    [Fact]
    public async Task ComputeAsync_OutputAndMemoryBudgetsRefuseWithoutPartialValues()
    {
        foreach (RevisionCompareBudgets budget in new[] { Budgets() with { MaxOutputBytes = 200 }, Budgets() with { MaxMemoryBytes = 30_000 } })
        {
            (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12), budgets: budget);
            RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
                .ComputeAsync(bundle, DateTimeOffset.UtcNow);
            Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
        }
    }

    [Fact]
    public async Task ComputeAsync_ReceiptAndMissingAuthorityReasonsShareTheOutputBudget()
    {
        RevisionComparePackage before = Package(11), after = Package(12);
        (RevisionComparePlanBundle initial, MutableReader initialReader) = await Plan(before, after);
        RevisionMetadataDiffResult measured = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(initialReader))
            .ComputeAsync(initial, DateTimeOffset.UtcNow);
        Assert.True(measured.IsReviewable);
        long boundary = RevisionMetadataDiffEngine.EstimateOutputBytes(measured.Receipt, measured.Fields);
        Assert.True(JsonSerializer.SerializeToUtf8Bytes(measured).Length <= boundary);
        foreach (int offset in new[] { -1, 0 })
        {
            (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(before, after,
                budgets: Budgets() with
                {
                    MaxOutputBytes = checked((int)boundary + offset)
                });
            var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
            RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
            if (offset < 0)
            {
                Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
                Assert.Equal("metadata_diff_output_budget", result.Receipt.Reason);
            }
            else
            {
                Assert.True(result.IsReviewable);
                Assert.True(await new RevisionMetadataDiffVerifier(engine).VerifyAsync(bundle, result, DateTimeOffset.UtcNow));
            }
        }
    }

    [Fact]
    public async Task ComputeAsync_ReservationRejectsNegativeAndOverflowBeforeReadingAuthority()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        foreach (long reservation in new[] { -1L, long.MaxValue })
        {
            reader.Reads = 0;
            RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow,
                reservedMemoryBytes: reservation);
            Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
            Assert.Equal("metadata_diff_memory_reservation_invalid", result.Receipt.Reason);
            Assert.Equal(0, reader.Reads);
        }
    }

    [Fact]
    public async Task VerifyAsync_ReservesHeldCandidateAndSourceBeforeIndependentWorker()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
        var verifier = new RevisionMetadataDiffVerifier(engine);
        foreach (long reservation in new[] { -1L, long.MaxValue, bundle.Plan.Budgets.MaxMemoryBytes })
        {
            reader.Reads = 0;
            Assert.False(await verifier.VerifyAsync(bundle, result, DateTimeOffset.UtcNow,
                reservedMemoryBytes: reservation));
            Assert.Equal(0, reader.Reads);
        }
    }

    [Fact]
    public async Task ComputeAsync_DraftRightsAreObservedInputsAndDoNotAcquireSnapshotDefaults()
    {
        RevisionComparePackage draft = RevisionComparePackageSeal.Create(7, RevisionCompareSourceKind.CurrentDraft,
            "draft:1", null, null, 1, "epoch-1", Encoding.UTF8.GetBytes("draft"), Metadata("draft", null, [1], 1),
            [RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights, "draft-rights:1:key:1", 1,
                JsonSerializer.SerializeToUtf8Bytes(new ArticleRightsRequest { LicenseType = null, CopyPolicy = null })),
             RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
             RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)]);
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(draft, Package(12));

        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);

        Assert.True(result.IsReviewable);
        Assert.Equal(RevisionMetadataDiffValueKind.Null, Field(result, "rights.license-type").Before.Kind);
        Assert.Equal(RevisionMetadataDiffValueKind.NotObserved, Field(result, "rights.identity").Before.Kind);
        Assert.Contains("rights.identity:missing-authority", result.Receipt.MissingAuthorities);
    }

    [Fact]
    public async Task VerifyAsync_RejectsFieldReceiptAndResealedResultTamper()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        var verifier = new RevisionMetadataDiffVerifier(engine);
        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
        ImmutableArray<RevisionMetadataDiffField> altered = result.Fields.SetItem(0,
            result.Fields[0] with
            {
                After = new(RevisionMetadataDiffValueKind.String, Text: "forged")
            });
        RevisionMetadataDiffResult tampered = result with
        {
            Fields = altered
        };
        Assert.False(RevisionMetadataDiffRepresentativeVerifier.Verify(bundle, tampered));
        Assert.False(await verifier.VerifyAsync(bundle, tampered, DateTimeOffset.UtcNow));
        tampered = tampered with
        {
            Receipt = tampered.Receipt with
            {
                ContentDigest = RevisionMetadataDiffEngine.Digest(tampered.Receipt, altered)
            }
        };
        Assert.False(await verifier.VerifyAsync(bundle, tampered, DateTimeOffset.UtcNow));
        Assert.False(await verifier.VerifyAsync(bundle, result with
        {
            Receipt = result.Receipt with
            {
                Coverage = RevisionMetadataDiffCoverage.Complete
            }
        }, DateTimeOffset.UtcNow));
    }

    [Theory]
    [InlineData("tag-ids")]
    [InlineData("rights.enabled")]
    [InlineData("rights.max-excerpt-chars")]
    [InlineData("rights.policy-hash")]
    [InlineData("responsibility.version")]
    [InlineData("release.publication-no")]
    public async Task RepresentativeVerifier_RejectsResealedFieldValuesFromDirectAuthorities(string id)
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        RevisionMetadataDiffResult result = await new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader))
            .ComputeAsync(bundle, DateTimeOffset.UtcNow);
        int index = result.Fields.IndexOf(Field(result, id));
        RevisionMetadataDiffField field = result.Fields[index];
        ImmutableArray<RevisionMetadataDiffField> altered = result.Fields.SetItem(index, field with
        {
            After = new(RevisionMetadataDiffValueKind.String, Text: "forged")
        });

        Assert.False(RevisionMetadataDiffRepresentativeVerifier.Verify(bundle, result with
        {
            Fields = altered,
            Receipt = result.Receipt with
            {
                ContentDigest = RevisionMetadataDiffEngine.Digest(result.Receipt, altered)
            }
        }));
    }

    [Theory]
    [InlineData("null-receipt")]
    [InlineData("default-fields")]
    [InlineData("default-reasons")]
    [InlineData("null-field")]
    [InlineData("null-before")]
    [InlineData("null-after")]
    [InlineData("default-added")]
    [InlineData("default-removed")]
    [InlineData("default-value-ids")]
    [InlineData("oversized-text")]
    [InlineData("oversized-field-set")]
    [InlineData("oversized-whitespace-field-id")]
    [InlineData("oversized-whitespace-reason")]
    [InlineData("unknown-value-kind")]
    public async Task VerifyAsync_RejectsMalformedOrOversizedCandidateBeforeHashingOrRereading(string mutation)
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
        RevisionMetadataDiffField first = result.Fields[0];
        RevisionMetadataDiffResult candidate = mutation switch
        {
            "null-receipt" => result with { Receipt = null! },
            "default-fields" => result with { Fields = default },
            "default-reasons" => result with { Receipt = result.Receipt with { MissingAuthorities = default } },
            "null-field" => result with { Fields = result.Fields.SetItem(0, null!) },
            "null-before" => result with { Fields = result.Fields.SetItem(0, first with { Before = null! }) },
            "null-after" => result with { Fields = result.Fields.SetItem(0, first with { After = null! }) },
            "default-added" => result with { Fields = result.Fields.SetItem(0, first with { AddedIds = default }) },
            "default-removed" => result with { Fields = result.Fields.SetItem(0, first with { RemovedIds = default }) },
            "default-value-ids" => result with { Fields = result.Fields.SetItem(0, first with { Before = first.Before with { Ids = default } }) },
            "oversized-text" => result with { Fields = result.Fields.SetItem(0, first with { Before = new(RevisionMetadataDiffValueKind.String, Text: new string('x', 1_000_000)) }) },
            "oversized-field-set" => result with { Fields = [.. Enumerable.Repeat(first, 10_000)], Receipt = result.Receipt with { FieldCount = 10_000 } },
            "oversized-whitespace-field-id" => result with { Fields = result.Fields.SetItem(0, first with { FieldId = new string(' ', 1_000_000) }) },
            "oversized-whitespace-reason" => result with { Receipt = result.Receipt with { MissingAuthorities = [new string(' ', 1_000_000)] } },
            "unknown-value-kind" => result with { Fields = result.Fields.SetItem(0, first with { Before = new((RevisionMetadataDiffValueKind)99) }) },
            _ => throw new InvalidOperationException()
        };
        reader.Reads = 0;

        Assert.False(await new RevisionMetadataDiffVerifier(engine).VerifyAsync(bundle, candidate, DateTimeOffset.UtcNow));
        Assert.Equal(0, reader.Reads);
    }

    [Fact]
    public async Task VerifyAsync_RejectsNullResultAndHonorsCancelledVerifier()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(Package(11), Package(12));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        var verifier = new RevisionMetadataDiffVerifier(engine);
        Assert.False(await verifier.VerifyAsync(bundle, null!, DateTimeOffset.UtcNow));
        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
        reader.Reads = 0;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.False(await verifier.VerifyAsync(bundle, result, DateTimeOffset.UtcNow, cancellation.Token));
        Assert.Equal(0, reader.Reads);
    }

    [Fact]
    public async Task VerifyAsync_LiteralNullStringCannotBeForgedAsAnAbsentTypedValue()
    {
        (RevisionComparePlanBundle bundle, MutableReader reader) = await Plan(
            Package(11, "null"), Package(12, "null"));
        var engine = new RevisionMetadataDiffEngine(new RevisionComparePlanVerifier(reader));
        RevisionMetadataDiffResult result = await engine.ComputeAsync(bundle, DateTimeOffset.UtcNow);
        int index = result.Fields.IndexOf(Field(result, "title"));
        RevisionMetadataDiffField field = result.Fields[index];
        ImmutableArray<RevisionMetadataDiffField> altered = result.Fields.SetItem(index, field with
        {
            Before = field.Before with
            {
                Text = null
            }
        });

        Assert.NotEqual(result.Receipt.ContentDigest, RevisionMetadataDiffEngine.Digest(result.Receipt, altered));
        Assert.False(await new RevisionMetadataDiffVerifier(engine).VerifyAsync(bundle,
            result with
            {
                Fields = altered
            }, DateTimeOffset.UtcNow));
    }

    private static void Refused(RevisionMetadataDiffResult result, RevisionMetadataDiffStatus status)
    {
        Assert.Equal(status, result.Receipt.Status);
        Assert.False(result.IsReviewable);
        Assert.Empty(result.Fields);
        Assert.Null(result.Receipt.FieldCount);
        Assert.Null(result.Receipt.BasePackageDigest);
        Assert.Null(result.Receipt.ComparePackageDigest);
        Assert.Null(result.Receipt.PlanDigest);
    }

    private static RevisionMetadataDiffField Field(RevisionMetadataDiffResult result, string id)
        => Assert.Single(result.Fields, field => field.FieldId == id);

    private static RevisionCompareMetadataValue[] Metadata(string title, string? summary, int[] tags, int category)
        => [RevisionCompareMetadataRegistry.String("title", title), RevisionCompareMetadataRegistry.NullableString("summary", summary),
            RevisionCompareMetadataRegistry.NullableString("cover-image-url", null), RevisionCompareMetadataRegistry.Int32("category-id", category),
            RevisionCompareMetadataRegistry.Int32List("tag-ids", tags)];

    private static RevisionComparePackage Package(long revision, string title = "same", string? summary = "same", int[]? tags = null,
        int category = 1, ArticleRevisionRightsSnapshotResponse? rights = null,
        ArticleRevisionResponsibilitySnapshotResponse? responsibility = null, RevisionCompareSnapshot[]? snapshots = null)
        => RevisionComparePackageSeal.Create(7, RevisionCompareSourceKind.HistoricalRevision, $"revision:{revision}", revision,
            (int)revision, null, null, Encoding.UTF8.GetBytes("source"), Metadata(title, summary, tags ?? [1, 3], category),
            snapshots ?? Snapshots(rights ?? Rights(), responsibility ?? Responsibility(), Release()));

    private static RevisionCompareSnapshot[] Snapshots(ArticleRevisionRightsSnapshotResponse rights,
        ArticleRevisionResponsibilitySnapshotResponse responsibility, ArticleRevisionReleaseResponse release)
        => [RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Rights, $"rights:{rights.Id}", 1, JsonSerializer.SerializeToUtf8Bytes(rights)),
            RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Responsibility,
                $"responsibility:{responsibility.Id}:{responsibility.ResponsibilityVersion}", responsibility.ResponsibilityVersion,
                JsonSerializer.SerializeToUtf8Bytes(responsibility)),
            RevisionCompareSnapshot.Present(RevisionCompareSnapshotKind.Release, $"release:{release.Id}:{release.PublicationNo}", 1,
                JsonSerializer.SerializeToUtf8Bytes(release))];

    private static ArticleRevisionRightsSnapshotResponse Rights()
        => new("101", true, "all-rights-reserved", "author", 2026, null, null, "append-attribution", 300,
            true, true, true, "sha256:" + new string('a', 64), "sha256:" + new string('b', 64), new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

    private static ArticleRevisionResponsibilitySnapshotResponse Responsibility()
        => new("201", 1, null, false, [new("author", null)], null,
            [new("private source", "https://example.test/private", "paper", new DateOnly(2026, 1, 2), null, null, false)],
            null, null, null, null, null, null, null, true, new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

    private static ArticleRevisionReleaseResponse Release()
        => new("301", 1, "immediate-publish", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));

    private static RevisionCompareBudgets Budgets() => new(10_000, 1_000, 10_000, 1_000_000, 10_000_000, 100, 10, 10_000);

    private static async Task<(RevisionComparePlanBundle Bundle, MutableReader Reader)> Plan(
        RevisionComparePackage before, RevisionComparePackage after, RevisionCompareBudgets? budgets = null, string[]? fields = null)
    {
        var reader = new MutableReader(before, after);
        var request = new RevisionComparePlanRequest(7, new(1, "primary", Guid.NewGuid()), Selector(before),
            Selector(after), new(RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1, 3, false,
                fields ?? ["title", "summary", "category-id", "tag-ids", "cover-image-url"]), budgets ?? Budgets(),
            "cancel-1", DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult plan = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(plan.IsSuccess, plan.Receipt.ReasonCode);
        return (plan.Bundle!, reader);
    }

    private static RevisionCompareSourceSelector Selector(RevisionComparePackage package)
        => package.SourceKind == RevisionCompareSourceKind.CurrentDraft
            ? new(package.SourceKind, DraftKey: "key", ExpectedServerRevision: package.ServerRevision, DocumentEpoch: package.DocumentEpoch)
            : new(package.SourceKind, package.RevisionId);

    private sealed class MutableReader(RevisionComparePackage before, RevisionComparePackage after) : IRevisionComparePackageReader
    {
        public RevisionComparePackage After { get; set; } = after;
        public int Reads
        {
            get; set;
        }
        public int? FailAt
        {
            get; set;
        }

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(RevisionCompareReadContext context,
            int articleId, RevisionCompareSourceSelector selector, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Reads++;
            return Task.FromResult(FailAt.HasValue && Reads >= FailAt
                ? RevisionComparePackageReadResult.Unavailable()
                : RevisionComparePackageReadResult.Available(selector.Kind == before.SourceKind && selector.RevisionId == before.RevisionId
                    && selector.ExpectedServerRevision == before.ServerRevision
                    ? before : After));
        }
    }

    private sealed class NeverReturningReader : IRevisionComparePackageReader
    {
        private readonly TaskCompletionSource<RevisionComparePackageReadResult> _never = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int Reads
        {
            get; private set;
        }

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(RevisionCompareReadContext context,
            int articleId, RevisionCompareSourceSelector selector, CancellationToken cancellationToken = default)
        {
            Reads++;
            return _never.Task;
        }
    }
}
