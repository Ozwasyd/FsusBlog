using System.Collections.Concurrent;

namespace FsusBlog.V2.Integration.Tests;

public sealed class WideSearchCorpusWorkerTests
{
    private const int Documents = WireLimits.SearchCorpusMaxPages * WireLimits.SearchIndexPageSize + 1;
    private static readonly DateTimeOffset Published = DateTimeOffset.FromUnixTimeMilliseconds(1_700_000_000_000);
    private static readonly TimeSpan TestDeadline = TimeSpan.FromSeconds(20);
    private static bool Supported => OperatingSystem.IsMacOS() || OperatingSystem.IsLinux();

    [Fact]
    public async Task TwoPinnedSpoolsKeepNewSourcesReadableAndOnlyNewestSourceCanStage()
    {
        if (!Supported) return;
        using var deadline = new CancellationTokenSource(TestDeadline);
        var ct = deadline.Token;
        var signal = new WideSearchCorpusSignal();
        var projection = new PublicProjection(signal);
        var first = Source(1);
        var second = Source(2, first);
        var superseded = Source(3, second);
        var newest = Source(4, superseded);
        var builds = new ConcurrentQueue<(PublicSnapshot Source, WideSearchCorpusStage Stage, int OpenBefore)>();
        using var worker = new WideSearchCorpusWorker(projection, signal, NullLogger<WideSearchCorpusWorker>.Instance,
            build: (source, token) =>
            {
                var openBefore = builds.Count(build => !build.Stage.Closed.IsCompletedSuccessfully);
                var stage = Build(source, token);
                builds.Enqueue((source, stage, openBefore));
                return stage;
            });
        await worker.StartAsync(ct);
        WideSearchCorpusStage? last = null;
        try
        {
            projection.Replace(first);
            var readyFirst = await Ready(projection, first, ct);
            using var firstPin = Assert.IsType<WideSearchCorpusStage.PageRead>(readyFirst.Stage.Borrow(1));

            projection.Replace(second);
            var readySecond = await Ready(projection, second, ct);
            Assert.False(CanBorrow(readyFirst.Stage));
            Assert.False(readyFirst.Stage.Closed.IsCompleted);
            using var secondPin = Assert.IsType<WideSearchCorpusStage.PageRead>(readySecond.Stage.Borrow(1));

            projection.Replace(superseded);
            AssertPending(projection, superseded);
            // Retirement rejects new borrows. Observe it before replacing this source with the next one.
            await Until(() => !CanBorrow(readySecond.Stage), ct);
            AssertPending(projection, superseded);
            Assert.False(readySecond.Stage.Closed.IsCompleted);
            Assert.Equal(new[] { first, second }, builds.Select(build => build.Source).ToArray());

            projection.Replace(newest);
            AssertPending(projection, newest);
            Assert.False(readyFirst.Stage.Closed.IsCompleted);
            Assert.False(readySecond.Stage.Closed.IsCompleted);

            var page = new byte[readyFirst.Stage.Manifest.Pages[0].Length];
            await firstPin.ReadAsync(page, ct);
            Assert.Equal(readyFirst.Stage.Manifest.Pages[0].Sha256, Convert.ToHexStringLower(SHA256.HashData(page)));
            await readyFirst.Stage.Closed.WaitAsync(ct);
            var readyNewest = await Ready(projection, newest, ct);
            last = readyNewest.Stage;
            Assert.False(readySecond.Stage.Closed.IsCompleted);
            Assert.Equal(new[] { first, second, newest }, builds.Select(build => build.Source).ToArray());
            Assert.Equal(new[] { 0, 1, 1 }, builds.Select(build => build.OpenBefore).ToArray());

            secondPin.Dispose();
            await readySecond.Stage.Closed.WaitAsync(ct);
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None).WaitAsync(TestDeadline);
        }
        Assert.True(Assert.IsType<WideSearchCorpusStage>(last).Closed.IsCompletedSuccessfully);
        Assert.Same(newest, projection.Current?.Source);
        Assert.Null(projection.Current?.Wide);
    }

    [Fact]
    public async Task StaleCompletedSpoolClosesWithoutAttachingToReplacementSource()
    {
        if (!Supported) return;
        using var deadline = new CancellationTokenSource(TestDeadline);
        var ct = deadline.Token;
        var signal = new WideSearchCorpusSignal();
        var projection = new PublicProjection(signal);
        var first = Source(1);
        var replacement = Source(2, first);
        var firstBuilt = new TaskCompletionSource<WideSearchCorpusStage>(TaskCreationOptions.RunContinuationsAsynchronously);
        var firstCancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var worker = new WideSearchCorpusWorker(projection, signal, NullLogger<WideSearchCorpusWorker>.Instance,
            build: (source, token) =>
            {
                if (!ReferenceEquals(first, source)) return Build(source, token);
                var stage = Build(source, token);
                try
                {
                    using var cancelled = token.Register(() => firstCancelled.TrySetResult());
                    firstBuilt.SetResult(stage);
                    // Return the sealed stage after the worker had to cancel this source.
                    releaseFirst.Task.WaitAsync(ct).GetAwaiter().GetResult();
                    return stage;
                }
                catch
                {
                    stage.Dispose();
                    throw;
                }
            });
        await worker.StartAsync(ct);
        try
        {
            projection.Replace(first);
            var stale = await firstBuilt.Task.WaitAsync(ct);
            AssertPending(projection, first);
            projection.Replace(replacement);
            await firstCancelled.Task.WaitAsync(ct);
            AssertPending(projection, replacement);
            Assert.False(stale.Closed.IsCompleted);
            releaseFirst.SetResult();

            var ready = await Ready(projection, replacement, ct);
            Assert.NotSame(stale, ready.Stage);
            await stale.Closed.WaitAsync(ct);
            Assert.False(CanBorrow(stale));
        }
        finally
        {
            releaseFirst.TrySetResult();
            await worker.StopAsync(CancellationToken.None).WaitAsync(TestDeadline);
        }
    }

    [Fact]
    public async Task BudgetFailureBlocksOnlyItsSourceAndAllowsTheNextSourceToStage()
    {
        if (!Supported) return;
        using var deadline = new CancellationTokenSource(TestDeadline);
        var ct = deadline.Token;
        var signal = new WideSearchCorpusSignal();
        var projection = new PublicProjection(signal);
        var rejected = Source(1);
        var successor = Source(2, rejected);
        var attempted = new ConcurrentQueue<PublicSnapshot>();
        using var worker = new WideSearchCorpusWorker(projection, signal, NullLogger<WideSearchCorpusWorker>.Instance,
            build: (source, token) =>
            {
                attempted.Enqueue(source);
                return ReferenceEquals(source, rejected)
                    ? WideSearchCorpusStage.Build(source.WideSearchArticles, 1, WireLimits.SearchWideCorpusTotalBytes, token)
                    : Build(source, token);
            });
        await worker.StartAsync(ct);
        try
        {
            projection.Replace(rejected);
            await Until(() => projection.Current is { WideBlocked: true }, ct);
            var blocked = Assert.IsType<PublicProjectionState>(projection.Current);
            Assert.Same(rejected, blocked.Source);
            Assert.Null(blocked.Wide);
            Assert.True(blocked.Source.HasArticle(Documents));
            Assert.Same(rejected, Assert.Single(attempted));
            projection.Replace(rejected);
            signal.Notify();
            Assert.Same(blocked, projection.Current);

            projection.Replace(successor);
            await Ready(projection, successor, ct);
            Assert.Equal(new[] { rejected, successor }, attempted.ToArray());
        }
        finally
        {
            await worker.StopAsync(CancellationToken.None).WaitAsync(TestDeadline);
        }
    }

    private static PublicSnapshot Source(int version, PublicSnapshot? previous = null)
    {
        var articles = Enumerable.Range(1, Documents).Select(id =>
            new Article(id, 1, id, 1, 1, "Corpus sample", "publication text", Published, Published, Published)).ToArray();
        articles[^1] = articles[^1] with { Revision = version, RevisionNo = version, Publication = Documents + (long)version };
        var snapshot = new PublicSnapshot(version, articles, new([], [], []), new WebPages(""),
            new PublicListCursor(TimeProvider.System), previous, NullLogger.Instance, null, null, CancellationToken.None);
        Assert.True(WideSearchCorpusWorker.IsEligible(snapshot));
        return snapshot;
    }

    private static WideSearchCorpusStage Build(PublicSnapshot source, CancellationToken ct) =>
        Assert.IsType<WideSearchCorpusStage>(WideSearchCorpusStage.Build(source.WideSearchArticles,
            WireLimits.SearchWideCorpusMaxPages, WireLimits.SearchWideCorpusTotalBytes, ct));

    private static async Task<WideSearchCorpusReady> Ready(PublicProjection projection, PublicSnapshot source, CancellationToken ct)
    {
        await Until(() => projection.Current is { Wide: not null } view && ReferenceEquals(view.Source, source), ct);
        var current = Assert.IsType<PublicProjectionState>(projection.Current);
        Assert.Same(source, current.Source);
        Assert.False(current.WideBlocked);
        var ready = Assert.IsType<WideSearchCorpusReady>(current.Wide);
        Assert.Equal(Documents, ready.Stage.Manifest.DocumentCount);
        var manifest = Aeds.Decode(ready.ManifestFrame, FrameType.PublicSearchWideManifest);
        Assert.Equal(source.Generation, BinaryPrimitives.ReadInt64LittleEndian(manifest[4..]));
        Assert.Equal(Documents, BinaryPrimitives.ReadInt32LittleEndian(manifest[12..]));
        return ready;
    }

    private static bool CanBorrow(WideSearchCorpusStage stage)
    {
        using var borrow = stage.Borrow(1);
        return borrow is not null;
    }

    private static void AssertPending(PublicProjection projection, PublicSnapshot source)
    {
        var current = Assert.IsType<PublicProjectionState>(projection.Current);
        Assert.Same(source, current.Source);
        Assert.Null(current.Wide);
        Assert.False(current.WideBlocked);
    }

    private static async Task Until(Func<bool> condition, CancellationToken ct)
    {
        while (!condition())
        {
            ct.ThrowIfCancellationRequested();
            await Task.Yield();
        }
    }
}
