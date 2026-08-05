namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Concurrency")]
public sealed class BackendConcurrencyModelTests
{
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
