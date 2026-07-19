using SqlSugar;

namespace FsusBlog.Server.Services;

internal static class UserSessionConcurrencyGate
{
    internal const int LockNamespace = 833064;

    internal static async Task AcquireAsync(ISqlSugarClient db, int userId)
    {
        if (db.CurrentConnectionConfig?.DbType != DbType.PostgreSQL)
        {
            return;
        }

        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(@LockNamespace, @UserId);",
            new SugarParameter("@LockNamespace", LockNamespace),
            new SugarParameter("@UserId", userId));
    }
}

internal static class UserSessionPolicy
{
    internal const string MaxActiveSessionsConfigurationKey = "Security:UserSessions:MaxActiveSessions";
    internal const int DefaultMaxActiveSessions = 10;
    internal const int MinimumMaxActiveSessions = 1;
    internal const int MaximumMaxActiveSessions = 50;

    internal static int ResolveMaxActiveSessions(IConfiguration? configuration)
        => Math.Clamp(
            configuration?.GetValue<int?>(MaxActiveSessionsConfigurationKey)
                ?? DefaultMaxActiveSessions,
            MinimumMaxActiveSessions,
            MaximumMaxActiveSessions);
}
