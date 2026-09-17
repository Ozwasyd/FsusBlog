using FsusBlog.Server.Infrastructure.Projections;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AccountStateProjectionTests
{
    private const string SubjectA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SubjectB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    [Fact]
    public void ApplyAuthoritative_EnforcesEntryLogicalAndCapacityBudgets()
    {
        var projection = CreateProjection(
            new DelegateSource((accountId, _) => ValueTask.FromResult(Present(accountId, 1, SubjectA))),
            maxEntries: 3,
            maxLogicalBytes: 2_000,
            maxCapacityBytes: 4_000);

        for (int accountId = 1; accountId <= 100_000; accountId++)
        {
            Assert.NotEqual(AccountStateApplyOutcome.Rejected, projection.ApplyAuthoritative(
                Present(accountId, accountId, SubjectA, publicHandle: $"handle-{accountId}")));
        }

        AccountStateProjectionRuntimeSnapshot snapshot = projection.Snapshot();
        Assert.Equal(3, snapshot.Entries);
        Assert.InRange(snapshot.LogicalBytes, 1, snapshot.Limits.MaxLogicalBytes);
        Assert.InRange(snapshot.CapacityBytes, 1, snapshot.Limits.MaxCapacityBytes);
        Assert.Equal(99_997, snapshot.Evictions);
    }

    [Fact]
    public void ApplyAuthoritative_UsesByteBudgetsEvenWhenEntryLimitHasRoom()
    {
        var projection = CreateProjection(
            new DelegateSource((accountId, _) => ValueTask.FromResult(Present(accountId, 1, SubjectA))),
            maxEntries: 100,
            maxLogicalBytes: 450,
            maxCapacityBytes: 1_000);

        projection.ApplyAuthoritative(Present(1, 1, SubjectA, new string('一', 80)));
        projection.ApplyAuthoritative(Present(2, 1, SubjectA, new string('二', 80)));

        AccountStateProjectionRuntimeSnapshot snapshot = projection.Snapshot();
        Assert.Equal(1, snapshot.Entries);
        Assert.True(snapshot.LogicalBytes <= snapshot.Limits.MaxLogicalBytes);
        Assert.True(snapshot.CapacityBytes <= snapshot.Limits.MaxCapacityBytes);
        Assert.Equal(1, snapshot.Evictions);
    }

    [Fact]
    public async Task GenerationOrdering_IsIdempotentAndConflictFailsClosedUntilNewerGeneration()
    {
        var source = new DelegateSource((accountId, _) => ValueTask.FromResult(Present(accountId, 3, SubjectA)));
        AccountStateProjection projection = CreateProjection(source);
        AccountStateSnapshot generationTwo = Present(42, 2, SubjectA, "stable");

        Assert.Equal(AccountStateApplyOutcome.Added, projection.ApplyAuthoritative(generationTwo));
        Assert.Equal(AccountStateApplyOutcome.IgnoredStale, projection.ApplyAuthoritative(Present(42, 1, SubjectA, "old")));
        Assert.Equal(AccountStateApplyOutcome.Idempotent, projection.ApplyAuthoritative(generationTwo));
        Assert.Equal(AccountStateApplyOutcome.Conflict, projection.ApplyAuthoritative(Present(42, 2, SubjectA, "split-brain")));

        AccountStateReadResult conflicted = await projection.ReadAsync(42, SubjectA);
        Assert.Equal(AccountStateReadOutcome.Conflict, conflicted.Outcome);
        Assert.Null(conflicted.Snapshot);
        Assert.Equal(0, source.LoadCount);

        Assert.Equal(AccountStateApplyOutcome.Updated, projection.ApplyAuthoritative(Present(42, 3, SubjectA, "recovered")));
        AccountStateReadResult recovered = await projection.ReadAsync(42, SubjectA);
        Assert.Equal(AccountStateReadOutcome.Present, recovered.Outcome);
        Assert.Equal("recovered", recovered.Snapshot!.PublicHandle);
        Assert.Equal(1, projection.Snapshot().Conflicts);
    }

    [Fact]
    public async Task Read_RequiresExactAccountAndSubjectBinding()
    {
        var source = new DelegateSource((_, _) => ValueTask.FromResult(Present(42, 1, SubjectA)));
        AccountStateProjection projection = CreateProjection(source);
        projection.ApplyAuthoritative(Present(42, 1, SubjectA));

        AccountStateReadResult valid = await projection.ReadAsync(42, SubjectA.ToUpperInvariant());
        AccountStateReadResult wrongSubject = await projection.ReadAsync(42, SubjectB);
        AccountStateReadResult wrongAccount = await projection.ReadAsync(84, SubjectA);

        Assert.True(valid.IsPresent);
        Assert.Equal(AccountStateReadOutcome.SubjectMismatch, wrongSubject.Outcome);
        Assert.Equal(AccountStateReadOutcome.Conflict, wrongAccount.Outcome);
        Assert.Null(wrongAccount.Snapshot);
        Assert.Equal(1, source.LoadCount);
    }

    [Fact]
    public async Task MissingDeletedAndUnknown_AreExplicitFailClosedStatesWithShortExpiry()
    {
        var clock = new ManualTimeProvider();
        var responses = new Queue<AccountStateSnapshot>(
        [
            Missing(42),
            Present(42, 1, SubjectA),
            new AccountStateSnapshot
            {
                AccountId = 84,
                Generation = 0,
                Knowledge = AccountStateKnowledge.Unknown
            }
        ]);
        var source = new DelegateSource((_, _) => ValueTask.FromResult(responses.Dequeue()));
        AccountStateProjection projection = CreateProjection(source, clock: clock);

        AccountStateReadResult missing = await projection.ReadAsync(42, SubjectA);
        Assert.Equal(AccountStateReadOutcome.Missing, missing.Outcome);
        Assert.Equal(1, source.LoadCount);
        Assert.Equal(AccountStateReadOutcome.Missing, (await projection.ReadAsync(42, SubjectA)).Outcome);
        Assert.Equal(1, source.LoadCount);

        clock.Advance(TimeSpan.FromSeconds(5));
        Assert.True((await projection.ReadAsync(42, SubjectA)).IsPresent);
        Assert.Equal(2, source.LoadCount);

        projection.ApplyAuthoritative(Deleted(42, 2, SubjectA));
        Assert.Equal(AccountStateReadOutcome.Deleted, (await projection.ReadAsync(42, SubjectA)).Outcome);
        clock.Advance(TimeSpan.FromSeconds(15));
        Assert.Equal(AccountStateReadOutcome.Unknown, (await projection.ReadAsync(84, SubjectA)).Outcome);
        Assert.Equal(3, source.LoadCount);
    }

    [Fact]
    public async Task SourceFailure_IsSingleFlightAndCachesUnknownBriefly()
    {
        var clock = new ManualTimeProvider();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new DelegateSource(async (_, _) =>
        {
            await release.Task;
            throw new InvalidOperationException("source-unavailable");
        });
        AccountStateProjection projection = CreateProjection(source, clock: clock);

        Task<AccountStateReadResult>[] reads = Enumerable.Range(0, 100)
            .Select(_ => projection.ReadAsync(42, SubjectA).AsTask())
            .ToArray();
        await EventuallyAsync(() => source.LoadCount == 1);
        release.SetResult();

        AccountStateReadResult[] results = await Task.WhenAll(reads);
        Assert.All(results, static result => Assert.Equal(AccountStateReadOutcome.Unknown, result.Outcome));
        Assert.Equal(1, source.LoadCount);
        Assert.Equal(AccountStateReadOutcome.Unknown, (await projection.ReadAsync(42, SubjectA)).Outcome);
        Assert.Equal(1, source.LoadCount);

        clock.Advance(TimeSpan.FromSeconds(1));
        Assert.Equal(AccountStateReadOutcome.Unknown, (await projection.ReadAsync(42, SubjectA)).Outcome);
        Assert.Equal(2, source.LoadCount);
    }

    [Fact]
    public async Task OneHundredConcurrentColdReads_UseOneWholeKeySourceFlight()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new DelegateSource(async (accountId, _) =>
        {
            entered.TrySetResult();
            await release.Task;
            return Present(accountId, 7, SubjectA);
        });
        AccountStateProjection projection = CreateProjection(source);

        Task<AccountStateReadResult>[] reads = Enumerable.Range(0, 100)
            .Select(_ => projection.ReadAsync(42, SubjectA).AsTask())
            .ToArray();
        await entered.Task;
        Assert.Equal(1, source.LoadCount);
        Assert.Equal(1, projection.Snapshot().ActiveLoads);

        release.SetResult();
        AccountStateReadResult[] results = await Task.WhenAll(reads);

        Assert.All(results, static result => Assert.True(result.IsPresent));
        Assert.Equal(1, source.LoadCount);
        Assert.Equal(0, projection.Snapshot().ActiveLoads);
    }

    [Fact]
    public async Task ConcurrentForceRefreshes_JoinOneAuthoritativeFlight_WithoutReplacingHotReadPath()
    {
        var refreshEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRefresh = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int generation = 1;
        var source = new DelegateSource(async (accountId, _) =>
        {
            int observed = Volatile.Read(ref generation);
            if (observed == 2)
            {
                refreshEntered.TrySetResult();
                await releaseRefresh.Task;
            }
            return Present(accountId, observed, SubjectA, $"generation-{observed}");
        });
        AccountStateProjection projection = CreateProjection(source);
        Assert.True((await projection.ReadAsync(42, SubjectA)).IsPresent);

        Volatile.Write(ref generation, 2);
        Task<AccountStateReadResult>[] refreshes = Enumerable.Range(0, 100)
            .Select(_ => projection.RefreshAsync(42, SubjectA).AsTask())
            .ToArray();
        await refreshEntered.Task;
        AccountStateReadResult hotDuringRefresh = await projection.ReadAsync(42, SubjectA);
        Assert.Equal("generation-1", hotDuringRefresh.Snapshot!.PublicHandle);
        Assert.Equal(2, source.LoadCount);

        releaseRefresh.SetResult();
        AccountStateReadResult[] results = await Task.WhenAll(refreshes);
        Assert.All(results, result => Assert.Equal("generation-2", result.Snapshot!.PublicHandle));
        Assert.Equal(2, source.LoadCount);
        Assert.Equal(100, projection.Snapshot().AuthoritativeRefreshes);
    }

    [Fact]
    public async Task FailedForceRefresh_IsUnknownWhileExistingHotSnapshotRemainsAvailable()
    {
        int attempts = 0;
        var source = new DelegateSource((accountId, _) =>
        {
            if (Interlocked.Increment(ref attempts) == 1)
            {
                return ValueTask.FromResult(Present(accountId, 1, SubjectA));
            }
            throw new InvalidOperationException("postgres-unavailable");
        });
        AccountStateProjection projection = CreateProjection(source);
        Assert.True((await projection.ReadAsync(42, SubjectA)).IsPresent);

        AccountStateReadResult refresh = await projection.RefreshAsync(42, SubjectA);
        AccountStateReadResult hot = await projection.ReadAsync(42, SubjectA);

        Assert.Equal(AccountStateReadOutcome.Unknown, refresh.Outcome);
        Assert.True(hot.IsPresent);
        Assert.Equal(2, source.LoadCount);
        Assert.Equal(1, projection.Snapshot().SourceFailures);
    }

    [Fact]
    public async Task EvictedEntry_AcceptsSameGenerationReplayInsteadOfUsingGlobalHighWatermark()
    {
        var source = new DelegateSource((accountId, _) => ValueTask.FromResult(Present(accountId, 1, SubjectA)));
        AccountStateProjection projection = CreateProjection(source, maxEntries: 1);
        AccountStateSnapshot replay = Present(1, 11, SubjectA, "first");

        Assert.Equal(AccountStateApplyOutcome.Added, projection.ApplyAuthoritative(replay));
        Assert.Equal(AccountStateApplyOutcome.Added, projection.ApplyAuthoritative(Present(2, 12, SubjectA, "second")));
        Assert.Equal(1, projection.Snapshot().Entries);
        Assert.Equal(AccountStateApplyOutcome.Added, projection.ApplyAuthoritative(replay));

        AccountStateReadResult result = await projection.ReadAsync(1, SubjectA);
        Assert.True(result.IsPresent);
        Assert.Equal(11, result.Snapshot!.Generation);
        Assert.Equal(0, source.LoadCount);
    }

    private static AccountStateProjection CreateProjection(
        IAccountStateProjectionSource source,
        int maxEntries = 100,
        long maxLogicalBytes = 1_000_000,
        long maxCapacityBytes = 2_000_000,
        TimeProvider? clock = null)
        => new(
            source,
            new AccountStateProjectionOptions
            {
                MaxEntries = maxEntries,
                MaxLogicalBytes = maxLogicalBytes,
                MaxCapacityBytes = maxCapacityBytes,
                MissingTtl = TimeSpan.FromSeconds(5),
                DeletedTtl = TimeSpan.FromSeconds(15),
                UnknownTtl = TimeSpan.FromSeconds(1)
            },
            clock);

    private static AccountStateSnapshot Present(
        int accountId,
        long generation,
        string subjectHash,
        string? publicHandle = "reader")
        => new()
        {
            AccountId = accountId,
            Generation = generation,
            Knowledge = AccountStateKnowledge.Present,
            AccountSubjectHash = subjectHash,
            Status = 0,
            IdentityKind = "anonymous_account",
            RegistrationState = "active",
            MfaEnabled = true,
            PasskeyEnabled = true,
            RecoveryEnabled = true,
            PublicHandle = publicHandle,
            AnonymousCredentialStatus = "active",
            AnonymousCredentialLevel = "basic"
        };

    private static AccountStateSnapshot Deleted(int accountId, long generation, string subjectHash)
        => Present(accountId, generation, subjectHash) with
        {
            Knowledge = AccountStateKnowledge.Deleted,
            Status = 2,
            DeletedAt = new DateTime(2026, 9, 13, 0, 0, 0, DateTimeKind.Utc)
        };

    private static AccountStateSnapshot Missing(int accountId)
        => new()
        {
            AccountId = accountId,
            Generation = 0,
            Knowledge = AccountStateKnowledge.Missing
        };

    private static async Task EventuallyAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(5));
        while (!predicate())
        {
            await Task.Delay(10, timeout.Token);
        }
    }

    private sealed class DelegateSource(
        Func<int, CancellationToken, ValueTask<AccountStateSnapshot>> loader) : IAccountStateProjectionSource
    {
        private int _loadCount;

        internal int LoadCount => Volatile.Read(ref _loadCount);

        public ValueTask<AccountStateSnapshot> LoadAsync(int accountId, CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _loadCount);
            return loader(accountId, cancellationToken);
        }
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _timestamp;

        public override long GetTimestamp() => Volatile.Read(ref _timestamp);

        internal void Advance(TimeSpan duration)
            => Interlocked.Add(
                ref _timestamp,
                (long)Math.Ceiling(duration.TotalSeconds * TimestampFrequency));
    }
}
