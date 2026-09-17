using System.Diagnostics;
using System.Text;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Services.Distribution;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SitemapArtifactCacheTests
{
    [Fact]
    public async Task GenerationDriftDiscardsWholeOldArtifactBeforeAtomicPublication()
    {
        var generation = new PublicAotInvalidationTracker();
        var cache = new SitemapArtifactCache(generation);
        int builds = 0;

        SitemapArtifactSet artifact = await cache.GetOrBuildAsync(
            async cancellationToken =>
            {
                int build = Interlocked.Increment(ref builds);
                if (build == 1)
                {
                    await generation.MarkSitemapAsync("article-mutation", cancellationToken);
                }

                return new SitemapArtifactBuildResult(
                    new SitemapArtifactSet($"root-{build}", [$"page-{build}-1", $"page-{build}-2"]),
                    AllocationBytes: 32);
            },
            CancellationToken.None);

        Assert.Equal(2, builds);
        Assert.Equal(1, artifact.Generation);
        Assert.Equal("root-2", artifact.RootDocument);
        Assert.Equal(["page-2-1", "page-2-2"], artifact.PageDocuments);
        SitemapArtifactCacheSnapshot snapshot = cache.Snapshot();
        Assert.Equal(1, snapshot.Generation);
        Assert.Equal(1, snapshot.ArtifactCount);
    }

    [Fact]
    [Trait("Category", "Performance")]
    public void LargeSitemapXmlBuildHasBoundedP99AllocationAndResidentBytes()
    {
        const int WarmupSamples = 8;
        const int Samples = 128;
        const long AllocationBudgetBytes = 256L * 1024 * 1024;
        const long ResidentBudgetBytes = 16L * 1024 * 1024;
        const double P99BudgetMilliseconds = 2_000;

        for (int sample = 0; sample < WarmupSamples; sample++)
        {
            _ = BlogDistributionService.BuildSitemapArtifactSetForTests(
                "https://public.example",
                45_001);
        }

        var elapsed = new double[Samples];
        var allocations = new long[Samples];
        long residentBytes = 0;
        for (int sample = 0; sample < Samples; sample++)
        {
            long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            long startedAt = Stopwatch.GetTimestamp();
            (string root, IReadOnlyList<string> pages) = BlogDistributionService
                .BuildSitemapArtifactSetForTests("https://public.example", 45_001);
            elapsed[sample] = Stopwatch.GetElapsedTime(startedAt).TotalMilliseconds;
            allocations[sample] = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            residentBytes = Encoding.UTF8.GetByteCount(root) + pages.Sum(Encoding.UTF8.GetByteCount);
            GC.KeepAlive(root);
            GC.KeepAlive(pages);
        }

        Array.Sort(elapsed);
        double p99 = elapsed[(int)Math.Ceiling(Samples * 0.99d) - 1];
        long maxAllocation = allocations.Max();
        Console.WriteLine(
            $"[sitemap-large-site] urls=45001 warmup={WarmupSamples} samples={Samples} p99Ms={p99:F2} maxAllocationBytes={maxAllocation} residentBytes={residentBytes}");
        Assert.True(
            p99 <= P99BudgetMilliseconds,
            $"sitemap p99 {p99:F2}ms exceeds {P99BudgetMilliseconds:F0}ms");
        Assert.True(
            maxAllocation <= AllocationBudgetBytes,
            $"sitemap allocation {maxAllocation} exceeds {AllocationBudgetBytes}");
        Assert.True(
            residentBytes <= ResidentBudgetBytes,
            $"sitemap resident bytes {residentBytes} exceeds {ResidentBudgetBytes}");
    }
}
