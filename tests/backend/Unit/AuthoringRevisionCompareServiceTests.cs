using System.Text;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringRevisionCompareServiceTests
{
    [Fact]
    public void RuntimeDomainRegistrations_ResolveRevisionCompareOrchestration()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        services.AddSingleton(Substitute.For<IAuthoringDraftLifecycle>());
        services.AddSingleton<IRevisionComparePackageReader, UnavailableReader>();
        services.AddSingleton<IRevisionMarkdownStructureAuthority>(new RevisionMarkdownStructureAuthority([]));
        services.AddSingleton(TimeProvider.System);
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope scope = provider.CreateScope();

        Assert.IsType<AuthoringRevisionCompareService>(
            scope.ServiceProvider.GetRequiredService<IAuthoringRevisionCompareService>());
        Assert.IsType<RevisionSourceDiffEngine>(
            scope.ServiceProvider.GetRequiredService<RevisionSourceDiffEngine>());
        Assert.IsType<AuthoringRevisionCompareDraftContextAuthority>(
            scope.ServiceProvider.GetRequiredService<IAuthoringRevisionCompareDraftContextAuthority>());
    }

    [Fact]
    public async Task CompareAsync_PlansAndVerifiesExactPackagesBeforeComputingDiff()
    {
        RevisionComparePackage baseline = Package(11, 1, "old\n");
        RevisionComparePackage compare = Package(12, 2, "new\n");
        var reader = new CountingReader(baseline, compare);
        AuthoringRevisionCompareService service = Service(reader);

        AuthoringRevisionCompareResult result = await service.CompareAsync(Request());

        Assert.True(result.IsReviewable, result.ReasonCode);
        Assert.False(result.IsSuccess);
        Assert.Equal(RevisionMetadataDiffStatus.PartialMissingAuthority, result.Status);
        Assert.Equal(16, reader.ReadCount);
        Assert.True(RevisionSourceDiffVerifier.Verify(result.Plan!.Bundle!, result.Diff!));
        Assert.NotNull(result.MetadataDiff);
        Assert.Equal(result.Plan.Receipt.PlanDigest, result.MetadataDiff.Receipt.PlanDigest);
        Assert.Contains("cover_asset_id_missing_authority", result.MetadataDiff.Receipt.MissingAuthorities);
        Assert.False((result with
        {
            Status = RevisionMetadataDiffStatus.Complete,
            ReasonCode = "accepted"
        }).IsReviewable);
        WriteDiagnosticFixture(result, "old\n", "new\n");
    }

    [Fact]
    public async Task CompareAsync_DoesNotInvokeEngineWhenAdmissionIsUnavailable()
    {
        var reader = new UnavailableReader();
        AuthoringRevisionCompareService service = Service(reader);

        AuthoringRevisionCompareResult result = await service.CompareAsync(Request());

        Assert.False(result.IsSuccess);
        Assert.Equal(RevisionComparePlanStatus.Unavailable, result.Plan!.Status);
        Assert.Null(result.Diff);
        Assert.Null(result.MetadataDiff);
        Assert.Equal(1, reader.ReadCount);
    }

    [Fact]
    public async Task CompareAsync_WithoutRequestedMetadataPreservesSourceOnlyResult()
    {
        var reader = new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n"));
        RevisionComparePlanRequest request = Request();
        AuthoringRevisionCompareResult result = await Service(reader).CompareAsync(request with
        {
            Options = new RevisionCompareOptions(request.Options.ViewMode, request.Options.WordSegmentation,
                request.Options.ContextLineCount, request.Options.HeadingNavigation, [])
        });

        Assert.True(result.IsSuccess, result.ReasonCode);
        Assert.True(result.IsReviewable);
        Assert.Null(result.MetadataDiff);
        Assert.Equal(6, reader.ReadCount);
        Assert.True(RevisionSourceDiffVerifier.Verify(result.Plan!.Bundle!, result.Diff!));
    }

    [Fact]
    public async Task CompareAsync_SharesOneDeadlineAcrossAdmissionWorkersAndVerification()
    {
        var reader = new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n"))
        {
            DelayMilliseconds = 30
        };
        RevisionComparePlanRequest request = Request();
        AuthoringRevisionCompareResult result = await Service(reader).CompareAsync(request with
        {
            Budgets = request.Budgets with
            {
                TimeoutMilliseconds = 200
            }
        }).WaitAsync(TimeSpan.FromSeconds(5));

        Refused(result, RevisionMetadataDiffStatus.Cancelled);
        Assert.Equal("article_revision_compare_timeout", result.ReasonCode);
        Assert.InRange(reader.ReadCount, 1, 15);
    }

    [Fact]
    public async Task CompareAsync_FinalPermissionRevocationDiscardsBothComputedResults()
    {
        var reader = new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n"))
        {
            DenyFromRead = 15
        };

        AuthoringRevisionCompareResult result = await Service(reader).CompareAsync(Request());

        Refused(result, RevisionMetadataDiffStatus.Stale);
        Assert.Equal("article_revision_compare_not_authorized", result.ReasonCode);
        Assert.Equal(16, reader.ReadCount);
    }

    [Fact]
    public async Task CompareAsync_CombinedOutputBudgetRejectsOneLessAndAcceptsExactBoundary()
    {
        AuthoringRevisionCompareResult baseline = await Service(new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n")))
            .CompareAsync(Request());
        Assert.True(baseline.IsReviewable);
        long boundary = baseline.Diff!.Receipt.EstimatedOutputBytes
            + RevisionMetadataDiffEngine.EstimateOutputBytes(baseline.MetadataDiff!.Receipt, baseline.MetadataDiff.Fields)
            + AuthoringRevisionCompareService.TransportOutputReserveBytes;
        Assert.True(SafeResponseBytes(baseline) <= boundary);
        foreach (int offset in new[] { -1, 0 })
        {
            RevisionComparePlanRequest request = Request();
            AuthoringRevisionCompareResult result = await Service(new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n")))
                .CompareAsync(request with
                {
                    Budgets = request.Budgets with
                    {
                        MaxOutputBytes = checked((int)boundary + offset)
                    }
                });
            if (offset < 0)
            {
                Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
                Assert.Equal("article_revision_compare_output_budget", result.ReasonCode);
            }
            else
            {
                Assert.True(result.IsReviewable, result.ReasonCode);
                Assert.True(SafeResponseBytes(result) <= result.Plan!.Bundle!.Plan.Budgets.MaxOutputBytes);
            }
        }
    }

    [Fact]
    public async Task CompareAsync_CombinedOutputBoundsJsonEscapingAndDecimalLongs()
    {
        string escaped = string.Concat(Enumerable.Repeat("\"\\\n\t<&😀", 128));
        AuthoringRevisionCompareResult result = await Service(new CountingReader(
                Package(11, 1, "old\n", escaped), Package(12, 2, "new\n", escaped + "changed")))
            .CompareAsync(Request());

        Assert.True(result.IsReviewable, result.ReasonCode);
        long estimate = result.Diff!.Receipt.EstimatedOutputBytes
            + RevisionMetadataDiffEngine.EstimateOutputBytes(result.MetadataDiff!.Receipt, result.MetadataDiff.Fields)
            + AuthoringRevisionCompareService.TransportOutputReserveBytes;
        Assert.True(SafeResponseBytes(result) <= estimate);
    }

    [Fact]
    public async Task CompareAsync_CombinedMemoryIncludesHeldSourceAndBothMetadataVerificationOutputs()
    {
        AuthoringRevisionCompareResult baseline = await Service(new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n")))
            .CompareAsync(Request());
        Assert.True(baseline.IsReviewable);
        long boundary = baseline.Diff!.Receipt.EstimatedMemoryBytes
            + AuthoringRevisionCompareService.TransportOutputReserveBytes
            + RevisionMetadataDiffEngine.EstimateInputReserveBytes(baseline.Plan!.Bundle!)
            + RevisionMetadataDiffEngine.EstimateOutputBytes(baseline.MetadataDiff!.Receipt, baseline.MetadataDiff.Fields) * 2;
        foreach (int offset in new[] { -1, 0 })
        {
            RevisionComparePlanRequest request = Request();
            AuthoringRevisionCompareResult result = await Service(new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n")))
                .CompareAsync(request with
                {
                    Budgets = request.Budgets with
                    {
                        MaxMemoryBytes = checked((int)boundary + offset)
                    }
                });
            if (offset < 0)
            {
                Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
                Assert.Equal("article_revision_compare_memory_budget", result.ReasonCode);
            }
            else
            {
                long held = baseline.Diff.Receipt.EstimatedMemoryBytes
                    + AuthoringRevisionCompareService.TransportOutputReserveBytes
                    + RevisionMetadataDiffEngine.EstimateOutputBytes(baseline.MetadataDiff.Receipt, baseline.MetadataDiff.Fields) * 2;
                bool finalStorageFits = AedsJsonResults.MemoryWithinBudget(
                    new(AedsJsonOutputBudgetStatus.Accepted, SafeResponseBytes(baseline)), held, boundary);
                if (finalStorageFits)
                    Assert.True(result.IsReviewable, result.ReasonCode);
                else
                {
                    Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
                    Assert.Equal("article_revision_compare_wire_memory_budget", result.ReasonCode);
                }
            }
        }
    }

    [Theory]
    [InlineData(170, false)]
    [InlineData(1_000, false)]
    [InlineData(170, true)]
    [InlineData(1_000, true)]
    public async Task CompareAsync_ActualCompleteJsonRefusesOldLogicalManyLineBound(int lines, bool includeMetadata)
    {
        string markdown = string.Concat(Enumerable.Repeat("x\n", lines));
        RevisionComparePlanRequest request = Request();
        request = request with
        {
            Budgets = new RevisionCompareBudgets(2_000_000, 110_000, 100_000, 8 * 1_024 * 1_024,
                64 * 1_024 * 1_024, 1_000, 64, 10_000),
            Options = new RevisionCompareOptions(request.Options.ViewMode, request.Options.WordSegmentation,
                request.Options.ContextLineCount, request.Options.HeadingNavigation, includeMetadata ? ["title"] : [])
        };
        AuthoringRevisionCompareResult baseline = await Service(new CountingReader(
            Package(11, 1, markdown), Package(12, 2, markdown))).CompareAsync(request);
        Assert.True(baseline.IsReviewable, baseline.ReasonCode);
        long oldBound = baseline.Diff!.Receipt.EstimatedOutputBytes + AuthoringRevisionCompareService.TransportOutputReserveBytes;
        if (includeMetadata)
            oldBound += RevisionMetadataDiffEngine.EstimateOutputBytes(baseline.MetadataDiff!.Receipt, baseline.MetadataDiff.Fields);
        Assert.True(SafeResponseBytes(baseline) > oldBound);
        var reader = new CountingReader(Package(11, 1, markdown), Package(12, 2, markdown));
        AuthoringRevisionCompareResult result = await Service(reader).CompareAsync(request with
        {
            Budgets = request.Budgets with
            {
                MaxOutputBytes = checked((int)oldBound)
            }
        });
        Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
        Assert.Equal("article_revision_compare_wire_output_budget", result.ReasonCode);
        Assert.Equal(includeMetadata ? 14 : 6, reader.ReadCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CompareAsync_WireMemoryPreflightRefusesBeforeMapping(bool includeMetadata)
    {
        RevisionComparePlanRequest request = Request();
        request = request with
        {
            Options = new RevisionCompareOptions(request.Options.ViewMode, request.Options.WordSegmentation,
                request.Options.ContextLineCount, request.Options.HeadingNavigation, includeMetadata ? ["title"] : [])
        };
        AuthoringRevisionCompareResult baseline = await Service(new CountingReader(
            Package(11, 1, "old\n"), Package(12, 2, "new\n"))).CompareAsync(request);
        Assert.True(baseline.IsReviewable, baseline.ReasonCode);
        long metadataOutput = includeMetadata
            ? RevisionMetadataDiffEngine.EstimateOutputBytes(baseline.MetadataDiff!.Receipt, baseline.MetadataDiff.Fields) : 0;
        long held = baseline.Diff!.Receipt.EstimatedMemoryBytes
            + AuthoringRevisionCompareService.TransportOutputReserveBytes + metadataOutput * 2;
        // Retain the original worker gates: when metadata verification needs
        // more than count preflight, test the final storage bound instead.
        long verification = includeMetadata
            ? baseline.Diff.Receipt.EstimatedMemoryBytes + AuthoringRevisionCompareService.TransportOutputReserveBytes
                + RevisionMetadataDiffEngine.EstimateInputReserveBytes(baseline.Plan!.Bundle!) + metadataOutput * 2 : 0;
        long countBoundary = held + AedsJsonResults.SerializationMemoryReserveBytes;
        long budget = Math.Max(verification, countBoundary - 1);
        AuthoringRevisionCompareResult result = await Service(new CountingReader(
            Package(11, 1, "old\n"), Package(12, 2, "new\n"))).CompareAsync(request with
            {
                Budgets = request.Budgets with
                {
                    MaxMemoryBytes = checked((int)budget)
                }
            });
        Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
        Assert.Equal("article_revision_compare_wire_memory_budget", result.ReasonCode);
    }

    [Fact]
    public async Task CompareAsync_AtomicEscapedTextRefusesFixedSerializerBuffer()
    {
        // This is an actual typed metadata DTO string in the canonical
        // registry/unit reader domain; raw Markdown is not exposed by the DTO.
        string title = new('<', 3_000);
        AuthoringRevisionCompareResult result = await Service(new CountingReader(
            Package(11, 1, "old\n", title), Package(12, 2, "new\n", title))).CompareAsync(Request());
        Refused(result, RevisionMetadataDiffStatus.BudgetExceeded);
        Assert.Equal("article_revision_compare_serialization_buffer_budget", result.ReasonCode);
    }

    [Fact]
    public async Task CompareAsync_CallerCancellationDoesNotPublishPartialSourceOrMetadata()
    {
        var reader = new CountingReader(Package(11, 1, "old\n"), Package(12, 2, "new\n"));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        AuthoringRevisionCompareResult result = await Service(reader).CompareAsync(Request(), cancellation.Token);

        Refused(result, RevisionMetadataDiffStatus.Cancelled);
        Assert.Equal("article_revision_compare_cancelled", result.ReasonCode);
        Assert.Equal(0, reader.ReadCount);
    }

    private static AuthoringRevisionCompareService Service(IRevisionComparePackageReader reader)
    {
        var verifier = new RevisionComparePlanVerifier(reader);
        var structure = new RevisionMarkdownStructureAuthority([]);
        var metadata = new RevisionMetadataDiffEngine(verifier);
        return new AuthoringRevisionCompareService(new RevisionComparePlanner(reader),
            new RevisionSourceDiffEngine(verifier, structure), metadata,
            new RevisionMetadataDiffVerifier(metadata), verifier, structure, TimeProvider.System);
    }

    private static void Refused(AuthoringRevisionCompareResult result, RevisionMetadataDiffStatus status)
    {
        Assert.False(result.IsSuccess);
        Assert.False(result.IsReviewable);
        Assert.Equal(status, result.Status);
        Assert.Null(result.Plan);
        Assert.Null(result.Diff);
        Assert.Null(result.MetadataDiff);
    }

    private static void WriteDiagnosticFixture(AuthoringRevisionCompareResult result, string before, string after)
    {
        string? directory = Environment.GetEnvironmentVariable("FSUSBLOG_REVISION_COMPARE_FIXTURE_DIR");
        if (directory is null)
            return;
        string ownedDirectory = Path.GetFullPath(directory);
        Assert.StartsWith("/tmp/fsusblog-3654-evidence/", ownedDirectory, StringComparison.Ordinal);
        Directory.CreateDirectory(ownedDirectory);
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true };
        File.WriteAllText(Path.Combine(ownedDirectory, "authorized-compare-unit-diagnostic.json"), JsonSerializer.Serialize(new
        {
            qualification = "original-service-unit-diagnostic; not HTTP, DB, publication or browser acceptance",
            beforeSource = before,
            afterSource = after,
            status = result.Status.ToString(),
            result.ReasonCode,
            requestOptions = result.Plan!.Bundle!.Plan.Options,
            baseSelector = result.Plan.Bundle.Plan.BaseSelector,
            compareSelector = result.Plan.Bundle.Plan.CompareSelector,
            baseSourceIdentity = result.Plan.Bundle.BasePackage.SourceIdentity,
            compareSourceIdentity = result.Plan.Bundle.ComparePackage.SourceIdentity,
            response = ArticleRevisionCompareResponse.From(ArticleRevisionComparePlanReceipt.From(result.Plan!.Receipt),
                result.Diff!, result.MetadataDiff)
        }, options));
    }

    private static int SafeResponseBytes(AuthoringRevisionCompareResult result)
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        return JsonSerializer.SerializeToUtf8Bytes(ArticleRevisionCompareResponse.From(
            ArticleRevisionComparePlanReceipt.From(result.Plan!.Receipt), result.Diff!, result.MetadataDiff), options).Length;
    }

    private static RevisionComparePlanRequest Request()
        => new(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.CurrentRevision, RevisionId: 12),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                false,
                ["title"]),
            new RevisionCompareBudgets(1_024, 100, 1_000, 1_024 * 1_024, 1_024 * 1_024, 32, 8, 10_000),
            "compare:7:11:12",
            DateTimeOffset.UtcNow.AddMinutes(5));

    private static RevisionComparePackage Package(long revisionId, int revisionNo, string markdown, string? title = null)
        => RevisionComparePackageSeal.Create(
            7,
            revisionId == 12 ? RevisionCompareSourceKind.CurrentRevision : RevisionCompareSourceKind.HistoricalRevision,
            $"revision:{revisionId}:{revisionNo}",
            revisionId,
            revisionNo,
            null,
            null,
            Encoding.UTF8.GetBytes(markdown),
            [RevisionCompareMetadataRegistry.String("title", title ?? (revisionId == 12 ? "New title" : "Old title"))],
            [
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Rights),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Responsibility),
                RevisionCompareSnapshot.NotApplicable(RevisionCompareSnapshotKind.Release)
            ]);

    private sealed class CountingReader(
        RevisionComparePackage baseline,
        RevisionComparePackage compare) : IRevisionComparePackageReader
    {
        public int ReadCount
        {
            get; private set;
        }

        public int DelayMilliseconds
        {
            get; init;
        }
        public int DenyFromRead { get; init; } = int.MaxValue;

        public async Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadCount++;
            if (DelayMilliseconds > 0)
                await Task.Delay(DelayMilliseconds, cancellationToken);
            return ReadCount >= DenyFromRead ? RevisionComparePackageReadResult.Unavailable()
                : RevisionComparePackageReadResult.Available(selector.RevisionId == baseline.RevisionId ? baseline : compare);
        }
    }

    private sealed class UnavailableReader : IRevisionComparePackageReader
    {
        public int ReadCount
        {
            get; private set;
        }

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadCount++;
            return Task.FromResult(RevisionComparePackageReadResult.Unavailable());
        }
    }
}
