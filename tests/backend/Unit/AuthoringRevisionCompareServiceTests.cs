using System.Text;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringRevisionCompareServiceTests
{
    [Fact]
    public void RuntimeDomainRegistrations_ResolveRevisionCompareOrchestration()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
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
        var planner = new RevisionComparePlanner(reader);
        var service = new AuthoringRevisionCompareService(
            planner,
            new RevisionSourceDiffEngine(
                new RevisionComparePlanVerifier(reader),
                new RevisionMarkdownStructureAuthority([])),
            TimeProvider.System);

        AuthoringRevisionCompareResult result = await service.CompareAsync(Request());

        Assert.True(result.IsSuccess, result.Diff?.Receipt.ReasonCode ?? result.Plan.Receipt.ReasonCode);
        Assert.Equal(6, reader.ReadCount);
        Assert.True(RevisionSourceDiffVerifier.Verify(result.Plan.Bundle!, result.Diff!));
    }

    [Fact]
    public async Task CompareAsync_DoesNotInvokeEngineWhenAdmissionIsUnavailable()
    {
        var reader = new UnavailableReader();
        var planner = new RevisionComparePlanner(reader);
        var service = new AuthoringRevisionCompareService(
            planner,
            new RevisionSourceDiffEngine(
                new RevisionComparePlanVerifier(reader),
                new RevisionMarkdownStructureAuthority([])),
            TimeProvider.System);

        AuthoringRevisionCompareResult result = await service.CompareAsync(Request());

        Assert.False(result.IsSuccess);
        Assert.Equal(RevisionComparePlanStatus.Unavailable, result.Plan.Status);
        Assert.Null(result.Diff);
        Assert.Equal(1, reader.ReadCount);
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

    private static RevisionComparePackage Package(long revisionId, int revisionNo, string markdown)
        => RevisionComparePackageSeal.Create(
            7,
            revisionId == 12 ? RevisionCompareSourceKind.CurrentRevision : RevisionCompareSourceKind.HistoricalRevision,
            $"revision:{revisionId}",
            revisionId,
            revisionNo,
            null,
            null,
            Encoding.UTF8.GetBytes(markdown),
            [RevisionCompareMetadataRegistry.String("title", "Title")],
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

        public Task<RevisionComparePackageReadResult> ReadAuthorizedAsync(
            RevisionCompareReadContext context,
            int articleId,
            RevisionCompareSourceSelector selector,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ReadCount++;
            return Task.FromResult(RevisionComparePackageReadResult.Available(
                selector.RevisionId == baseline.RevisionId ? baseline : compare));
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
