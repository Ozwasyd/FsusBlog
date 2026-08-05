namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
public sealed class BackendConcurrencyModelTests
{
    [Fact]
    public async Task PasskeyRegistrationLimitRace_StopsAtConfiguredLimit()
    {
        var credentials = new BoundedCredentialSet(limit: 5);
        int successCount = await RaceAsync(24, () => credentials.TryAdd(Guid.NewGuid().ToString("N")));

        Assert.Equal(5, successCount);
        Assert.Equal(5, credentials.Count);
    }

    [Fact]
    public async Task UploadCompleteRace_FinalizesOnceAndReturnsStableMutation()
    {
        var completion = new IdempotentCompletion();
        int successCount = await RaceAsync(20, completion.TryComplete);

        Assert.Equal(1, successCount);
        Assert.Equal("completed", completion.State);
        Assert.Equal(1, completion.FinalizationCount);
    }

    [Fact]
    public async Task RefreshLogoutAllRace_RejectsRefreshAfterGlobalRevocation()
    {
        var sessions = new SessionRevocationModel();
        using var start = new Barrier(2);

        Task<bool> refresh = Task.Run(() =>
        {
            start.SignalAndWait();
            return sessions.TryRefresh(observedVersion: 0);
        });

        Task logoutAll = Task.Run(() =>
        {
            start.SignalAndWait();
            sessions.LogoutAll();
        });

        await Task.WhenAll(refresh, logoutAll);

        Assert.False(sessions.TryRefresh(observedVersion: 0));
        Assert.True(sessions.GlobalRevocationVersion > 0);
    }

    private static async Task<int> RaceAsync(int participants, Func<bool> action)
    {
        int readyCount = 0;
        var allReady = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var start = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<int>[] tasks = Enumerable.Range(0, participants)
            .Select(_ => Task.Run(async () =>
            {
                if (Interlocked.Increment(ref readyCount) == participants)
                {
                    allReady.TrySetResult(true);
                }

                await start.Task.ConfigureAwait(false);
                return action() ? 1 : 0;
            }))
            .ToArray();

        await allReady.Task.WaitAsync(TimeSpan.FromSeconds(10));
        start.TrySetResult(true);
        int[] results = await Task.WhenAll(tasks);
        return results.Sum();
    }

    private sealed class BoundedCredentialSet(int limit)
    {
        private readonly HashSet<string> _credentials = [];
        private readonly object _lock = new();

        public int Count
        {
            get
            {
                lock (_lock)
                {
                    return _credentials.Count;
                }
            }
        }

        public bool TryAdd(string credentialId)
        {
            lock (_lock)
            {
                if (_credentials.Count >= limit)
                {
                    return false;
                }

                return _credentials.Add(credentialId);
            }
        }
    }

    private sealed class IdempotentCompletion
    {
        private int _completed;

        public string State { get; private set; } = "uploading";

        public int FinalizationCount
        {
            get; private set;
        }

        public bool TryComplete()
        {
            if (Interlocked.CompareExchange(ref _completed, 1, 0) != 0)
            {
                return false;
            }

            State = "completed";
            FinalizationCount++;
            return true;
        }
    }

    private sealed class SessionRevocationModel
    {
        private int _globalRevocationVersion;

        public int GlobalRevocationVersion => Volatile.Read(ref _globalRevocationVersion);

        public void LogoutAll()
            => Interlocked.Increment(ref _globalRevocationVersion);

        public bool TryRefresh(int observedVersion)
            => observedVersion >= Volatile.Read(ref _globalRevocationVersion);
    }
}
