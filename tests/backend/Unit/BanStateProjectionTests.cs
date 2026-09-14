using System.Collections.Concurrent;
using System.Text;

using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BanStateProjectionTests
{
    private const string SubjectA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SubjectB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string SubjectC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

    [Theory]
    [InlineData(BanStateProjectionStatus.Normal, null)]
    [InlineData(BanStateProjectionStatus.Banned, "manual_ban")]
    [InlineData(BanStateProjectionStatus.Deleted, null)]
    public void ApplyAndRead_RepresentsEveryAuthoritativeStatus(
        BanStateProjectionStatus status,
        string? reasonCode)
    {
        var source = new RecordingSource((_, _) => throw new InvalidOperationException("source must not run"));
        var projection = new BanStateProjection(source);

        BanStateProjectionApplyResult applied = projection.Apply(
            new BanStateProjectionUpdate(SubjectA.ToUpperInvariant(), status, reasonCode, 7));
        BanStateProjectionLookup lookup = projection.Read(SubjectA);

        Assert.Equal(BanStateProjectionApplyResult.Applied, applied);
        Assert.True(lookup.IsKnown);
        Assert.Equal(status, lookup.Status);
        Assert.Equal(reasonCode, lookup.ReasonCode);
        Assert.Equal(7, lookup.Generation);
        Assert.Equal(0, source.CallCount);
        Assert.Equal(1, projection.Snapshot().Entries);
    }

    [Fact]
    public void Apply_RejectsStaleAndDuplicateAndFailsClosedOnSameGenerationConflict()
    {
        var projection = new BanStateProjection(RecordingSource.Missing());

        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Normal, null, 10)));
        Assert.Equal(
            BanStateProjectionApplyResult.RejectedStale,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Banned, "manual_ban", 9)));
        Assert.Equal(
            BanStateProjectionApplyResult.RejectedDuplicate,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Normal, null, 10)));
        Assert.Equal(
            BanStateProjectionApplyResult.FailedClosedConflict,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Banned, "manual_ban", 10)));

        BanStateProjectionLookup conflicted = projection.Read(SubjectA);
        Assert.Equal(BanStateProjectionStatus.Unknown, conflicted.Status);
        Assert.Equal(10, conflicted.Generation);

        Assert.Equal(
            BanStateProjectionApplyResult.RejectedStale,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Normal, null, 9)));
        Assert.Equal(BanStateProjectionStatus.Unknown, projection.Read(SubjectA).Status);

        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Banned, "manual_ban", 11)));
        Assert.Equal(BanStateProjectionStatus.Banned, projection.Read(SubjectA).Status);

        BanStateProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(2, snapshot.StaleUpdates);
        Assert.Equal(1, snapshot.DuplicateUpdates);
        Assert.Equal(1, snapshot.Conflicts);
    }

    [Fact]
    public void Apply_EnforcesEntryAndUtf8ResidentByteBudgetsAndEvictionReturnsUnknown()
    {
        const string UnicodeReason = "封禁";
        int bannedBytes = Encoding.UTF8.GetByteCount(SubjectA) + Encoding.UTF8.GetByteCount(UnicodeReason);
        var projection = new BanStateProjection(
            RecordingSource.Missing(),
            new BanStateProjectionLimits
            {
                MaxEntries = 2,
                MaxUtf8ResidentBytes = bannedBytes + Encoding.UTF8.GetByteCount(SubjectB),
                MaxReasonCodeUtf8Bytes = Encoding.UTF8.GetByteCount(UnicodeReason)
            });

        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Banned, UnicodeReason, 1)));
        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectB, BanStateProjectionStatus.Normal, null, 1)));

        BanStateProjectionSnapshot full = projection.Snapshot();
        Assert.Equal(2, full.Entries);
        Assert.Equal(bannedBytes + Encoding.UTF8.GetByteCount(SubjectB), full.Utf8ResidentBytes);
        Assert.True(full.Utf8ResidentBytes <= full.MaxUtf8ResidentBytes);

        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectC, BanStateProjectionStatus.Deleted, null, 1)));

        Assert.Equal(BanStateProjectionStatus.Unknown, projection.Read(SubjectA).Status);
        Assert.Equal(BanStateProjectionStatus.Normal, projection.Read(SubjectB).Status);
        Assert.Equal(BanStateProjectionStatus.Deleted, projection.Read(SubjectC).Status);
        BanStateProjectionSnapshot evicted = projection.Snapshot();
        Assert.Equal(2, evicted.Entries);
        Assert.True(evicted.Utf8ResidentBytes <= evicted.MaxUtf8ResidentBytes);
        Assert.Equal(1, evicted.Evictions);
    }

    [Fact]
    public void Apply_OneHundredThousandSubjectsNeverExceedsResidentBudgets()
    {
        const int MaxEntries = 1_024;
        const long MaxBytes = MaxEntries * 64L;
        var projection = new BanStateProjection(
            RecordingSource.Missing(),
            new BanStateProjectionLimits
            {
                MaxEntries = MaxEntries,
                MaxUtf8ResidentBytes = MaxBytes,
                MaxReasonCodeUtf8Bytes = 64
            });

        for (int index = 0; index < 100_000; index++)
        {
            string subjectHash = index.ToString("x64", System.Globalization.CultureInfo.InvariantCulture);
            Assert.Equal(
                BanStateProjectionApplyResult.Applied,
                projection.Apply(new BanStateProjectionUpdate(
                    subjectHash,
                    BanStateProjectionStatus.Normal,
                    null,
                    1)));
        }

        BanStateProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(MaxEntries, snapshot.Entries);
        Assert.Equal(MaxBytes, snapshot.Utf8ResidentBytes);
        Assert.True(snapshot.Entries <= snapshot.MaxEntries);
        Assert.True(snapshot.Utf8ResidentBytes <= snapshot.MaxUtf8ResidentBytes);
        Assert.Equal(100_000 - MaxEntries, snapshot.Evictions);
    }

    [Fact]
    public async Task KnownHotRead_OneThousandConcurrentCallersNeverInvokeSource()
    {
        var source = new RecordingSource((_, _) => throw new InvalidOperationException("known reads reached source"));
        var projection = new BanStateProjection(source);
        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Banned, "manual_ban", 42)));

        Task<BanStateProjectionLookup>[] reads = Enumerable.Range(0, 1_000)
            .Select(index => projection.GetAsync(index + 1, SubjectA).AsTask())
            .ToArray();
        BanStateProjectionLookup[] results = await Task.WhenAll(reads);

        Assert.All(results, result =>
        {
            Assert.Equal(BanStateProjectionStatus.Banned, result.Status);
            Assert.Equal(42, result.Generation);
        });
        Assert.Equal(0, source.CallCount);
        Assert.Equal(1_000, projection.Snapshot().KnownReads);
    }

    [Fact]
    public async Task UnknownRead_OneThousandConcurrentCallersUseOneWholeSubjectSourceLoad()
    {
        var sourceStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSource = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new RecordingSource(async (subjectHash, cancellationToken) =>
        {
            sourceStarted.TrySetResult();
            await releaseSource.Task.WaitAsync(cancellationToken);
            return new BanStateProjectionUpdate(
                subjectHash,
                BanStateProjectionStatus.Normal,
                null,
                5);
        });
        var projection = new BanStateProjection(source);

        Task<BanStateProjectionLookup>[] reads = Enumerable.Range(0, 1_000)
            .Select(index => projection.GetAsync(
                index + 1,
                index % 2 == 0 ? SubjectA : SubjectA.ToUpperInvariant()).AsTask())
            .ToArray();
        await sourceStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, source.CallCount);

        releaseSource.TrySetResult();
        BanStateProjectionLookup[] results = await Task.WhenAll(reads);

        Assert.All(results, result => Assert.Equal(BanStateProjectionStatus.Normal, result.Status));
        Assert.Equal(1, source.CallCount);
        Assert.Equal(1, projection.Snapshot().SourceLoads);
    }

    [Fact]
    public async Task UnknownRead_CanceledFirstWaiterDoesNotBreakWholeSubjectSingleflight()
    {
        var sourceStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseSource = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new RecordingSource(async (subjectHash, _) =>
        {
            sourceStarted.TrySetResult();
            await releaseSource.Task;
            return new BanStateProjectionUpdate(
                subjectHash,
                BanStateProjectionStatus.Normal,
                null,
                3);
        });
        var projection = new BanStateProjection(source);
        using var cancellation = new CancellationTokenSource();

        Task<BanStateProjectionLookup> first = projection.GetAsync(SubjectA, cancellation.Token).AsTask();
        await sourceStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => first);

        Task<BanStateProjectionLookup> second = projection.GetAsync(SubjectA).AsTask();
        Assert.Equal(1, source.CallCount);
        releaseSource.TrySetResult();

        Assert.Equal(BanStateProjectionStatus.Normal, (await second).Status);
        Assert.Equal(1, source.CallCount);
    }

    [Fact]
    public async Task UnknownSourceMissingOrSubjectMismatchNeverBecomesNormal()
    {
        var responses = new ConcurrentQueue<BanStateProjectionUpdate?>();
        responses.Enqueue(null);
        responses.Enqueue(new BanStateProjectionUpdate(SubjectB, BanStateProjectionStatus.Normal, null, 1));
        var source = new RecordingSource((_, _) => ValueTask.FromResult(responses.TryDequeue(out var value) ? value : null));
        var projection = new BanStateProjection(source);

        BanStateProjectionLookup missing = await projection.GetAsync(SubjectA);
        BanStateProjectionLookup mismatch = await projection.GetAsync(SubjectA);

        Assert.Equal(BanStateProjectionStatus.Unknown, missing.Status);
        Assert.Equal(BanStateProjectionStatus.Unknown, mismatch.Status);
        Assert.Equal(BanStateProjectionStatus.Unknown, projection.Read(SubjectA).Status);
        Assert.Equal(2, source.CallCount);
    }

    [Fact]
    public async Task UnknownSourceFailure_FailsClosedAndDoesNotCreateNormalState()
    {
        var projection = new BanStateProjection(new ThrowingSource());

        await Assert.ThrowsAsync<IOException>(
            () => projection.GetAsync(42, SubjectA).AsTask());

        Assert.Equal(BanStateProjectionStatus.Unknown, projection.Read(SubjectA).Status);
        Assert.Equal(1, projection.Snapshot().SourceLoads);
    }

    [Fact]
    public void OversizedHigherGenerationFailsClosedInsteadOfPreservingKnownNormal()
    {
        var projection = new BanStateProjection(
            RecordingSource.Missing(),
            new BanStateProjectionLimits
            {
                MaxEntries = 2,
                MaxUtf8ResidentBytes = 256,
                MaxReasonCodeUtf8Bytes = 4
            });
        Assert.Equal(
            BanStateProjectionApplyResult.Applied,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Normal, null, 1)));

        Assert.Equal(
            BanStateProjectionApplyResult.RejectedInvalid,
            projection.Apply(new BanStateProjectionUpdate(SubjectA, BanStateProjectionStatus.Banned, "oversized", 2)));

        BanStateProjectionLookup lookup = projection.Read(SubjectA);
        Assert.Equal(BanStateProjectionStatus.Unknown, lookup.Status);
        Assert.Equal(2, lookup.Generation);
    }

    private sealed class RecordingSource(
        Func<string, CancellationToken, ValueTask<BanStateProjectionUpdate?>> load)
        : IBanStateProjectionSource
    {
        private int _callCount;

        public int CallCount => Volatile.Read(ref _callCount);

        public static RecordingSource Missing()
            => new((_, _) => ValueTask.FromResult<BanStateProjectionUpdate?>(null));

        public async ValueTask<BanStateProjectionUpdate?> LoadAsync(
            int accountId,
            string accountSubjectHash,
            CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref _callCount);
            return await load(accountSubjectHash, cancellationToken);
        }
    }

    private sealed class ThrowingSource : IBanStateProjectionSource
    {
        public ValueTask<BanStateProjectionUpdate?> LoadAsync(
            int accountId,
            string accountSubjectHash,
            CancellationToken cancellationToken = default)
            => ValueTask.FromException<BanStateProjectionUpdate?>(
                new IOException("authority unavailable"));
    }
}
