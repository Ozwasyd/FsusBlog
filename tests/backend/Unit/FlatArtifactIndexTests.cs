using System.Numerics;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Host;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

using FlatArtifactIndexLease = FsusBlog.Server.Infrastructure.Memory.Host.FlatArtifactIndex.FlatArtifactIndexLease;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FlatArtifactIndexTests
{
    private static readonly FlatArtifactIndexLimits s_limits = new(256, 256, 64, 1_000_000);

    [Fact]
    public void ReferenceAndFlatAgreeForFullHashCollisionsCanonicalAliasesAndExtremeKeys()
    {
        string maximum = new('m', s_limits.MaximumKeyBytes - PublicHotReadRouteKeys.HtmlPath("x").Length + 1);
        FlatArtifactIndexEntry[] entries = [Entry(1, "s0bcl2jxuoma"), Entry(2, "1c3dtr2ffbte"),
            Entry(3, "文章:你好"), Entry(4, "  ARTICLE:42  "), Entry(5, maximum), Entry(6, "empty", 0)];
        Assert.Equal(3711975695U, Hash(entries[0].RouteKey));
        Assert.Equal(Hash(entries[0].RouteKey), Hash(entries[1].RouteKey));
        Assert.NotEqual(PublicHotReadRouteKeys.HtmlPath(entries[0].RouteKey), PublicHotReadRouteKeys.HtmlPath(entries[1].RouteKey));
        var (ledger, domain) = Ledger();
        using FlatArtifactIndex flat = Build(ledger, domain, entries);
        using FlatArtifactIndexLease lease = Acquire(flat);
        Compare(new(entries, s_limits), lease, entries);
        Assert.True(lease.TryGetRoute("article:42", out FlatArtifactDescriptor alias));
        Assert.Equal(entries[3].Descriptor, alias);
        Assert.False(lease.TryGetRoute(new string('x', 257), out _));
        Assert.Equal(flat.Descriptor.Layout.CapacityBytes, Used(ledger));
        Assert.Single(ledger.Allocations());
    }

    [Fact]
    public void CopyOnWriteDeletesReplacesAndAddsWithoutChangingAnOldReader()
    {
        var (ledger, domain) = Ledger();
        FlatArtifactIndexEntry[] original = [Entry(1, "first"), Entry(2, "second"), Entry(3, "third")];
        using FlatArtifactIndex old = Build(ledger, domain, original);
        using FlatArtifactIndexLease oldLease = Acquire(old);
        FlatArtifactIndexEntry replacement = Entry(2, "second-new", 99);
        FlatArtifactIndexEntry added = Entry(4, "文章:新");
        MemoryOperationResult<FlatArtifactIndex> updated = FlatArtifactIndex.TryUpdate(ledger, domain, Content(), oldLease,
            [new(1, null), new(2, replacement), new(4, added)], s_limits);
        Assert.True(updated.Succeeded);
        using FlatArtifactIndex next = updated.Value!;
        using FlatArtifactIndexLease nextLease = Acquire(next);
        FlatArtifactIndexEntry[] expected = [replacement, original[2], added];
        Compare(new(expected, s_limits), nextLease, expected);
        Assert.False(nextLease.TryGetId(1, out _));
        Assert.False(nextLease.TryGetRoute("second", out _));
        Compare(new(original, s_limits), oldLease, original);
        Assert.Equal(old.Descriptor.Layout.CapacityBytes + next.Descriptor.Layout.CapacityBytes, Used(ledger));
        Assert.Equal(2, ledger.Allocations().Count);
        Assert.Contains(ledger.EventWindow().Events, entry => entry.Kind == "reserved"
            && entry.Delta.Values.Any(value => value > next.Descriptor.Layout.CapacityBytes));
    }

    [Fact]
    public void InvalidBuildsAndCanonicalDuplicatesReturnTheirReservations()
    {
        var (ledger, domain) = Ledger();
        FlatArtifactIndexEntry valid = Entry(1, "first");
        FlatArtifactIndexEntry[][] invalid = [[valid, Entry(1, "other")], [valid, Entry(2, " FIRST ")],
            [valid with { Descriptor = valid.Descriptor with { Content = default } }],
            [valid with { Descriptor = valid.Descriptor with { PayloadLocation = default } }],
            [valid with { Descriptor = valid.Descriptor with { PayloadLength = -1 } }],
            [valid with { RouteKey = new string('a', 257) }], [null!]];
        foreach (FlatArtifactIndexEntry[] entries in invalid)
        {
            Assert.Equal(MemoryFailure.BoundsViolation,
                FlatArtifactIndex.TryBuild(ledger, domain, Content(), entries, s_limits).Failure);
            Assert.Equal(0, Used(ledger));
            Assert.Equal(0, ledger.Snapshot().Reservations);
            Assert.Empty(ledger.Allocations());
        }
    }

    [Fact]
    public void LayoutRejectsManagedReferencesMalformedRangesAndOverflowBeforeNativeAccess()
    {
        Assert.True(FlatArtifactIndexLayout.IsUnmanagedRecord<FlatArtifactDescriptor>());
        Assert.False(FlatArtifactIndexLayout.IsUnmanagedRecord<FlatArtifactIndexEntry>());
        Assert.False(FlatArtifactIndexLayout.IsUnmanagedRecord<ManagedField>());
        FlatArtifactIndexLayout layout = FlatArtifactIndexLayout.TryPlan(2, 40, s_limits).Value!;
        int[] offsets = [-1, 0, 1, 7, 8, 104, 1_000_000, int.MaxValue];
        int[] counts = [-1, 0, 1, 2, int.MaxValue];
        int[] sizes = [-1, 0, 1, 16, 104, int.MaxValue];
        int[] alignments = [0, 1, 3, 8, 16];
        foreach (int offset in offsets)
        {
            foreach (int count in counts)
            {
                foreach (int size in sizes)
                {
                    foreach (int alignment in alignments)
                    {
                        bool expected = offset >= 0 && count >= 0 && size > 0 && alignment > 0
                            && (alignment & (alignment - 1)) == 0 && offset % alignment == 0
                            && offset <= layout.Allocation.LogicalBytes
                            && (BigInteger)count * size <= layout.Allocation.LogicalBytes - offset;
                        Assert.Equal(expected, layout.Contains(offset, count, size, alignment));
                    }
                }
            }
        }
        Assert.False(layout.ContainsKey(-1, 1, 256));
        Assert.False(layout.ContainsKey(1, int.MaxValue, 256));
        Assert.False(layout.ContainsKey(int.MaxValue, 1, 256));
        Assert.False(layout.ContainsKey(40, 1, 256));
        Assert.False(layout.ContainsKey(0, 0, 256));
        Assert.True(layout.ContainsKey(0, 40, 256));
        Assert.Equal(MemoryFailure.BoundsViolation, FlatArtifactIndexLayout.TryPlan(int.MaxValue, 0, s_limits).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, FlatArtifactIndexLayout.TryPlan(1, int.MaxValue, s_limits).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, FlatArtifactIndexLayout.TryPlan(1, 10,
            new(int.MaxValue / 4, 256, 1, 8)).Failure);
    }

    [Fact]
    public async Task RetirementIsIdempotentAndRetainsOneChargeUntilEveryActualReaderEnds()
    {
        var (ledger, domain) = Ledger();
        FlatArtifactIndexEntry entry = Entry(1, "retained");
        FlatArtifactIndex index = Build(ledger, domain, [entry]);
        FlatArtifactIndexLease first = Acquire(index);
        FlatArtifactIndexLease second = Acquire(index);
        index.Dispose();
        index.Dispose();
        Assert.False(index.Drained.IsCompleted);
        Assert.Equal(MemoryFailure.OwnershipViolation, index.TryAcquire(index.Location).Failure);
        Assert.True(first.TryGetId(1, out FlatArtifactDescriptor descriptor));
        Assert.Equal(entry.Descriptor, descriptor);
        first.Dispose();
        first.Dispose();
        Assert.Equal(index.Descriptor.Layout.CapacityBytes, Used(ledger));
        Assert.True(second.TryGetRoute("retained", out _));
        Assert.Throws<ObjectDisposedException>(() => first.TryGetId(1, out _));
        second.Dispose();
        await index.Drained.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(0, Used(ledger));
        Assert.Empty(ledger.Allocations());
    }

    [Fact]
    public async Task CancelledOuterWaitDoesNotReleaseAnIndexUsedByUnderlyingAsyncWork()
    {
        var (ledger, domain) = Ledger();
        FlatArtifactIndex index = Build(ledger, domain, [Entry(1, "async")]);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var complete = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task ConsumeAsync()
        {
            using FlatArtifactIndexLease lease = Acquire(index);
            started.SetResult();
            await complete.Task;
            Assert.True(lease.TryGetId(1, out _));
        }
        Task operation = ConsumeAsync();
        await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
        index.Dispose();
        Assert.False(index.Drained.IsCompleted);
        Assert.Equal(index.Descriptor.Layout.CapacityBytes, Used(ledger));
        complete.SetResult();
        await operation.WaitAsync(TimeSpan.FromSeconds(10));
        await index.Drained.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(0, Used(ledger));
    }

    [Fact]
    public void StaleTokensReaderLimitsAndFailedUpdatesDoNotDamageTheLiveSource()
    {
        var (ledger, domain) = Ledger();
        FlatArtifactIndexLimits limits = s_limits with
        {
            MaximumReaders = 1
        };
        using FlatArtifactIndex index = FlatArtifactIndex.TryBuild(ledger, domain, Content(), [Entry(1, "live")], limits).Value!;
        using FlatArtifactIndexLease lease = Acquire(index);
        Assert.Equal(MemoryFailure.BudgetRejected, index.TryAcquire(index.Location).Failure);
        Assert.Equal(MemoryFailure.StaleLocation, index.TryAcquire(index.Location with
        {
            Revision = new(2)
        }).Failure);
        Assert.Equal(MemoryFailure.BoundsViolation, FlatArtifactIndex.TryUpdate(ledger, domain, Content(), lease,
            [new(1, Entry(2, "wrong-id"))], limits).Failure);
        long retained = Used(ledger);
        ledger.ReviseLimits(2, [new(domain, MemoryResourceUnit.Bytes, retained)]);
        Assert.Equal(MemoryFailure.BudgetRejected, FlatArtifactIndex.TryUpdate(ledger, domain, Content(), lease,
            [new(2, Entry(2, "new"))], limits).Failure);
        Assert.Equal(retained, Used(ledger));
        Assert.True(lease.TryGetId(1, out _));
        Assert.Equal(0, ledger.Snapshot().Reservations);
    }

    [Fact]
    public async Task RepeatedPublicationKeepsAnOldReaderChargedAndDrainsOnlyAtItsCompletion()
    {
        var (ledger, domain) = Ledger();
        using var publication = new FlatArtifactIndexPublication();
        FlatArtifactIndex first = Build(ledger, domain, [Entry(1, "first")]);
        Assert.True(publication.TryPublish(first));
        FlatArtifactIndexLease retained = publication.TryAcquire().Value!;
        FlatArtifactIndex? current = null;
        for (int generation = 2; generation < 25; generation++)
        {
            current = Build(ledger, domain, [Entry(generation, "current")]);
            Assert.True(publication.TryPublish(current));
            using FlatArtifactIndexLease lease = publication.TryAcquire().Value!;
            Assert.True(lease.TryGetId(generation, out _));
            Assert.True(retained.TryGetId(1, out _));
            Assert.Equal(first.Descriptor.Layout.CapacityBytes + current.Descriptor.Layout.CapacityBytes, Used(ledger));
            Assert.Equal(2, ledger.Allocations().Count);
        }
        publication.Dispose();
        Assert.Equal(first.Descriptor.Layout.CapacityBytes, Used(ledger));
        Assert.False(first.Drained.IsCompleted);
        Assert.True(current!.Drained.IsCompleted);
        retained.Dispose();
        await first.Drained.WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(0, Used(ledger));
    }

    [Fact]
    public async Task ConcurrentSelectionAndPublicationObserveOnlyCompleteGenerations()
    {
        var (ledger, domain) = Ledger();
        using var publication = new FlatArtifactIndexPublication();
        Assert.True(publication.TryPublish(Build(ledger, domain, [Entry(1, "shared")])));
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task[] readers = Enumerable.Range(0, 8).Select(_ => Task.Run(async () =>
        {
            await start.Task;
            for (int iteration = 0; iteration < 1000; iteration++)
            {
                MemoryOperationResult<FlatArtifactIndexLease> acquired = publication.TryAcquire();
                Assert.True(acquired.Succeeded);
                using FlatArtifactIndexLease lease = acquired.Value!;
                Assert.True(lease.TryGetRoute("shared", out FlatArtifactDescriptor route));
                Assert.True(lease.TryGetId(route.Id, out FlatArtifactDescriptor id));
                Assert.Equal(route, id);
                await Task.Yield();
            }
        })).ToArray();
        Task publisher = Task.Run(async () =>
        {
            await start.Task;
            for (int generation = 2; generation <= 100; generation++)
            {
                Assert.True(publication.TryPublish(Build(ledger, domain, [Entry(generation, "shared")])));
                await Task.Yield();
            }
        });
        start.SetResult();
        await Task.WhenAll(readers.Append(publisher)).WaitAsync(TimeSpan.FromSeconds(30));
        publication.Dispose();
        Assert.Equal(0, Used(ledger));
        Assert.False(ledger.Snapshot().Faulted);
    }

    [Fact]
    public void RepeatedBuildUpdateAndRetirementLeaveNoPersistentOwnership()
    {
        var (ledger, domain) = Ledger();
        for (int cycle = 0; cycle < 50; cycle++)
        {
            using (FlatArtifactIndex index = Build(ledger, domain, [Entry(1, "source")]))
            {
                using FlatArtifactIndexLease source = Acquire(index);
                using FlatArtifactIndex next = FlatArtifactIndex.TryUpdate(ledger, domain, Content(), source,
                    [new(1, Entry(1, "replacement"))], s_limits).Value!;
                using FlatArtifactIndexLease reader = Acquire(next);
                Assert.True(reader.TryGetRoute("replacement", out _));
            }
            Assert.Equal(0, Used(ledger));
            Assert.Empty(ledger.Allocations());
            Assert.Equal(0, ledger.Snapshot().Reservations);
        }
    }

    [Fact]
    public void PublicationTransfersOwnershipOnceAndEmptyIndexesRemainReadable()
    {
        var (ledger, domain) = Ledger();
        using var first = new FlatArtifactIndexPublication();
        using var second = new FlatArtifactIndexPublication();
        FlatArtifactIndex index = Build(ledger, domain, []);
        Assert.True(first.TryPublish(index));
        Assert.False(first.TryPublish(index));
        Assert.False(second.TryPublish(index));
        using FlatArtifactIndexLease lease = first.TryAcquire().Value!;
        Assert.False(lease.TryGetId(1, out _));
        Assert.False(lease.TryGetRoute("missing", out _));
        first.Dispose();
        FlatArtifactIndex other = Build(ledger, domain, [Entry(1, "other")]);
        Assert.False(first.TryPublish(other));
        other.Dispose();
        Assert.Equal(index.Descriptor.Layout.CapacityBytes, Used(ledger));
    }

    private static void Compare(ReferenceArtifactIndex reference, FlatArtifactIndexLease flat,
        IReadOnlyList<FlatArtifactIndexEntry> entries)
    {
        foreach (long id in entries.Select(entry => entry.Descriptor.Id).Append(long.MaxValue).Append(-1))
        {
            Assert.Equal(reference.TryGetId(id, out FlatArtifactDescriptor expected), flat.TryGetId(id, out FlatArtifactDescriptor actual));
            Assert.Equal(expected, actual);
        }
        foreach (string key in entries.SelectMany(entry => new[] { entry.RouteKey, PublicHotReadRouteKeys.HtmlPath(entry.RouteKey) })
            .Append("absent-key"))
        {
            Assert.Equal(reference.TryGetRoute(key, out FlatArtifactDescriptor expected), flat.TryGetRoute(key, out FlatArtifactDescriptor actual));
            Assert.Equal(expected, actual);
        }
    }

    private static FlatArtifactIndex Build(MemoryReservationCoordinator ledger, ResourceDomainId domain,
        IReadOnlyList<FlatArtifactIndexEntry> entries)
    {
        MemoryOperationResult<FlatArtifactIndex> result = FlatArtifactIndex.TryBuild(ledger, domain, Content(), entries, s_limits);
        Assert.True(result.Succeeded, result.Failure?.ToString());
        return result.Value!;
    }

    private static FlatArtifactIndexLease Acquire(FlatArtifactIndex index)
    {
        MemoryOperationResult<FlatArtifactIndexLease> result = index.TryAcquire(index.Location);
        Assert.True(result.Succeeded);
        return result.Value!;
    }

    private static FlatArtifactIndexEntry Entry(long id, string key, long length = 10)
        => new(key, new(id, Content(), new(new(Guid.NewGuid()), new(Guid.NewGuid()), new(1), new(1)), length));

    private static MemoryContentIdentity Content() => new(new(Guid.NewGuid()), new(1), new(Guid.NewGuid()));

    private static uint Hash(string route) => FlatArtifactIndexLayout.RouteHash(Encoding.UTF8.GetBytes(PublicHotReadRouteKeys.HtmlPath(route)));

    private static long Used(MemoryReservationCoordinator ledger) => ledger.Snapshot().Used["flat-index-host"];

    private static (MemoryReservationCoordinator Ledger, ResourceDomainId Domain) Ledger(long capacity = 10_000_000)
    {
        var domain = new ResourceDomainId(Guid.NewGuid());
        var topology = new MemoryResourceTopology([new(domain, "flat-index-host", MemoryResourceUnit.Bytes, null)]);
        return (new(topology, [new(domain, MemoryResourceUnit.Bytes, capacity)], 1, 1024, 1024), domain);
    }

    private readonly record struct ManagedField(string Value);
}
