using FsusBlog.Server.Infrastructure.Projections;

using Microsoft.Extensions.Options;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleDetailViewProjectionTests(ITestOutputHelper output)
{
    [Fact]
    public void Project_UsesMaximumWithoutAllowingOutOfOrderRegression()
    {
        var projection = new ArticleDetailViewProjection();

        projection.ApplyAuthoritative(42, 120, version: 20);
        projection.ApplyAuthoritative(42, 110, version: 21);
        projection.ApplyAuthoritative(42, 120, version: 19);

        Assert.Equal(120, projection.Project(42, persistedViews: 100));
        Assert.Equal(130, projection.Project(42, persistedViews: 130));

        projection.ApplyAuthoritative(42, 125, version: 18);
        Assert.Equal(120, projection.Project(42, persistedViews: 100));
    }

    [Fact]
    public void ApplyAuthoritative_EnforcesEntryLogicalAndCapacityBudgets()
    {
        var projection = new ArticleDetailViewProjection(Options.Create(new ArticleDetailViewProjectionOptions
        {
            MaxEntries = 3,
            MaxLogicalBytes = 3 * ArticleDetailViewProjection.LogicalBytesPerEntry,
            MaxCapacityBytes = 3 * ArticleDetailViewProjection.CapacityBytesPerEntry,
            EntryTtl = TimeSpan.FromMinutes(5)
        }));

        for (int articleId = 1; articleId <= 10_000; articleId++)
        {
            projection.ApplyAuthoritative(articleId, articleId, articleId);
        }

        ArticleDetailViewProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(3, snapshot.Entries);
        Assert.True(snapshot.LogicalBytes <= snapshot.Limits.MaxLogicalBytes);
        Assert.True(snapshot.CapacityBytes <= snapshot.Limits.MaxCapacityBytes);
        Assert.Equal(10_000, projection.Project(10_000, 0));
        Assert.Equal(1, projection.Project(1, 1));
        Assert.Equal(9_997, snapshot.Evictions);
    }

    [Fact]
    public void TenThousandEntries_ReportsActualAllocationAndRetainedCapacityEvidence()
    {
        const int EntryCount = 10_000;
        var projection = new ArticleDetailViewProjection(Options.Create(new ArticleDetailViewProjectionOptions
        {
            MaxEntries = EntryCount,
            MaxLogicalBytes = EntryCount * ArticleDetailViewProjection.LogicalBytesPerEntry,
            MaxCapacityBytes = EntryCount * ArticleDetailViewProjection.CapacityBytesPerEntry,
            EntryTtl = TimeSpan.FromMinutes(5)
        }));
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        long retainedBefore = GC.GetTotalMemory(forceFullCollection: true);
        long allocatedBefore = GC.GetAllocatedBytesForCurrentThread();

        for (int articleId = 1; articleId <= EntryCount; articleId++)
        {
            projection.ApplyAuthoritative(articleId, articleId, articleId);
        }

        long allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
        long retainedBytes = Math.Max(0, GC.GetTotalMemory(forceFullCollection: true) - retainedBefore);
        ArticleDetailViewProjectionSnapshot snapshot = projection.Snapshot();
        output.WriteLine(
            "entries={0} allocatedBytes={1} retainedBytes={2} logicalBytes={3} capacityBudgetBytes={4}",
            snapshot.Entries,
            allocatedBytes,
            retainedBytes,
            snapshot.LogicalBytes,
            snapshot.CapacityBytes);

        Assert.Equal(EntryCount, snapshot.Entries);
        Assert.InRange(allocatedBytes, 1, 32L * 1024 * 1024);
        Assert.InRange(retainedBytes, 0, 16L * 1024 * 1024);
        Assert.True(snapshot.LogicalBytes <= snapshot.Limits.MaxLogicalBytes);
        Assert.True(snapshot.CapacityBytes <= snapshot.Limits.MaxCapacityBytes);
    }

    [Fact]
    public void Project_ExpiredEntryFallsBackToPersistedPayloadWithoutSourceRead()
    {
        var clock = new ManualTimeProvider();
        var projection = new ArticleDetailViewProjection(
            Options.Create(new ArticleDetailViewProjectionOptions
            {
                MaxEntries = 10,
                MaxLogicalBytes = 1_000,
                MaxCapacityBytes = 1_000,
                EntryTtl = TimeSpan.FromSeconds(5)
            }),
            clock);
        projection.ApplyAuthoritative(7, 80, version: 1);

        Assert.Equal(80, projection.Project(7, 70));
        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.Equal(70, projection.Project(7, 70));
    }

    [Fact]
    public void ApplyAuthoritative_ExpiredEntryAcceptsSameVersionReplay()
    {
        var clock = new ManualTimeProvider();
        var projection = new ArticleDetailViewProjection(
            Options.Create(new ArticleDetailViewProjectionOptions
            {
                MaxEntries = 10,
                MaxLogicalBytes = 1_000,
                MaxCapacityBytes = 1_000,
                EntryTtl = TimeSpan.FromSeconds(5)
            }),
            clock);
        projection.ApplyAuthoritative(7, 80, version: 11);

        clock.Advance(TimeSpan.FromSeconds(5));
        projection.ApplyAuthoritative(7, 80, version: 11);

        Assert.Equal(80, projection.Project(7, 70));
        Assert.Equal(1, projection.Snapshot().Entries);
    }

    [Fact]
    public void ApplyAuthoritative_RejectsInvalidIdentityValueAndVersion()
    {
        var projection = new ArticleDetailViewProjection();

        projection.ApplyAuthoritative(0, 1, 1);
        projection.ApplyAuthoritative(1, -1, 1);
        projection.ApplyAuthoritative(1, 1, 0);

        ArticleDetailViewProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(0, snapshot.Entries);
        Assert.Equal(3, snapshot.AdmissionRejects);
    }

    [Fact]
    public async Task ConcurrentOutOfOrderUpdatesAndReads_NeverRegressDisplayedValue()
    {
        var projection = new ArticleDetailViewProjection();
        projection.ApplyAuthoritative(42, 100, 100);
        int regression = 0;
        int maximumObserved = 100;
        using var start = new ManualResetEventSlim(false);
        Task[] writers = Enumerable.Range(1, 10_000)
            .Reverse()
            .Chunk(250)
            .Select(chunk => Task.Run(() =>
            {
                start.Wait();
                foreach (int views in chunk)
                {
                    projection.ApplyAuthoritative(42, views, views);
                }
            }))
            .ToArray();
        Task[] readers = Enumerable.Range(0, 8)
            .Select(_ => Task.Run(() =>
            {
                start.Wait();
                for (int i = 0; i < 20_000; i++)
                {
                    int observed = projection.Project(42, 1);
                    int previous = InterlockedExtensions.Max(ref maximumObserved, observed);
                    if (observed < previous)
                    {
                        Interlocked.Exchange(ref regression, 1);
                    }
                }
            }))
            .ToArray();

        start.Set();
        await Task.WhenAll([.. writers, .. readers]);

        Assert.Equal(0, Volatile.Read(ref regression));
        Assert.Equal(10_000, projection.Project(42, 1));
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _timestamp;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Volatile.Read(ref _timestamp);

        public void Advance(TimeSpan delta)
            => Interlocked.Add(ref _timestamp, delta.Ticks);
    }

    private static class InterlockedExtensions
    {
        public static int Max(ref int location, int value)
        {
            int current = Volatile.Read(ref location);
            while (current < value)
            {
                int observed = Interlocked.CompareExchange(ref location, value, current);
                if (observed == current)
                {
                    return value;
                }

                current = observed;
            }

            return current;
        }
    }
}
