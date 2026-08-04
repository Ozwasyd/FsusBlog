using System.Reflection;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Caching.Memory;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AdminSessionValidationServiceTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly SemaphoreSlim s_databaseResetLock = new(1, 1);
    private static string? s_sharedConnectionString;

    [Fact]
    public void JwtBearerEvents_RuntimeHandlerValidatesAdminSessionAfterTokenSignature()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(JwtServiceExtensions),
            nameof(JwtServiceExtensions.AddJwtAuthentication));

        Assert.Contains("JwtBearerEvents.set_OnTokenValidated", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IAdminSessionValidationService", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("IAdminSessionValidationService.ValidateAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AuthCookieService.ClearAdminSessionCookies", runtimeShape, StringComparison.Ordinal);
        Assert.Contains(".Fail", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ValidateAsync_AllowsActiveSessionAndUpdatesLastSeen()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "active-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(Token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), Token, CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "sid-1");
        Assert.NotNull(session.LastSeenAtUtc);
        Assert.True(session.LastSeenAtUtc > before);
    }

    [Fact]
    public async Task ValidateAsync_UsesInjectedBusinessClockForExpiry()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "business-clock-admin-token";
        DateTimeOffset businessNow = new(2026, 6, 2, 12, 0, 0, TimeSpan.Zero);
        AdminSession session = CreateSession(accessTokenHash: HashForStorage(Token));
        session.IdleExpiresAtUtc = businessNow.UtcDateTime.AddMinutes(10);
        session.AbsoluteExpiresAtUtc = businessNow.UtcDateTime.AddHours(1);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), session);
        var service = new AdminSessionValidationService(
            db,
            timeProvider: new TestBusinessTimeProvider(businessNow));

        AdminSessionValidationResult result = await service.ValidateAsync(
            CreateClaimsPrincipal(1, "sid-1"),
            Token,
            CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
    }

    [Fact]
    public async Task ValidateCurrentSessionAfterTouchConflict_AllowsConcurrentLastSeenUpdate()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "concurrent-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(Token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db);

        await db.Updateable<AdminSession>()
            .SetColumns(session => session.LastSeenAtUtc == DateTime.UtcNow)
            .Where(session => session.SessionId == "sid-1")
            .ExecuteCommandAsync();

        AdminSessionValidationResult result = await InvokeValidateCurrentSessionAfterTouchConflictAsync(
            service,
            adminId: 1,
            sessionId: "sid-1",
            currentTokenHash: HashForStorage(Token),
            now: DateTime.UtcNow);

        Assert.True(result.IsValid, result.Reason);
    }

    [Fact]
    public void ValidateAsync_RuntimeMetadataUsesBoundedSnapshotAndRowVersionGuardForLastSeenTouch()
    {
        Type serviceType = typeof(AdminSessionValidationService);
        TimeSpan snapshotTtl = (TimeSpan)serviceType
            .GetField("s_adminSessionValidationSnapshotTtl", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetValue(null)!;
        TimeSpan touchInterval = (TimeSpan)serviceType
            .GetField("s_adminSessionTouchMinInterval", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetValue(null)!;
        Assert.Equal(TimeSpan.FromSeconds(10), snapshotTtl);
        Assert.Equal(TimeSpan.FromSeconds(45), touchInterval);

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            serviceType,
            nameof(AdminSessionValidationService.ValidateAsync),
            "LoadAdminSessionValidationStateAsync",
            "TryTouchAdminSessionAsync",
            "ValidateCurrentSessionAfterTouchConflictAsync",
            "TryGetValidationSnapshot",
            "SetValidationSnapshot",
            "ShouldTouchAdminSession");
        Assert.Contains("AdminSessionValidationSnapshot", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("MemoryCacheEntryOptions", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("JOIN admin_principal ap ON ap.id = s.adminprincipalid", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ap.status AS principal_status", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND accesstokenhash = @AccessTokenHash", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND idleexpiresatutc = @IdleExpiresAtUtc", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("RecordAdminSessionValidationDbRead", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RecordAdminSessionValidationCacheHit", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RecordAdminSessionTouchSkipped", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("RecordAdminSessionTouch", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("admin_session_conflict", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("InSingleAsync", runtimeShape, StringComparison.Ordinal);

        HashSet<string> instruments = typeof(FsusObservability)
            .GetFields(BindingFlags.Static | BindingFlags.NonPublic)
            .Select(static field => field.GetValue(null))
            .OfType<System.Diagnostics.Metrics.Instrument>()
            .Select(static instrument => instrument.Name)
            .ToHashSet(StringComparer.Ordinal);
        Assert.Contains("fsus.admin.session.validation.db_read_count", instruments);
        Assert.Contains("fsus.admin.session.validation.cache_hit", instruments);
        Assert.Contains("fsus.admin.session.touch_skipped", instruments);
        Assert.Contains("fsus.admin.session.touch_elapsed_ms", instruments);
    }

    [Fact]
    public async Task ValidateAsync_SecondSnapshotHitDoesNotTouchLastSeenAgain()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "snapshot-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        using var cache = new MemoryCache(new MemoryCacheOptions());
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(Token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db, cache);

        AdminSessionValidationResult first = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), Token, CancellationToken.None);
        AdminSession afterFirst = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "sid-1");
        AdminSessionValidationResult second = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), Token, CancellationToken.None);
        AdminSession afterSecond = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "sid-1");

        Assert.True(first.IsValid, first.Reason);
        Assert.True(second.IsValid, second.Reason);
        Assert.True(afterFirst.LastSeenAtUtc > before);
        Assert.Equal(afterFirst.LastSeenAtUtc, afterSecond.LastSeenAtUtc);
    }

    [Fact]
    public async Task ValidateAsync_RejectsNonAdminPrincipalWhenInvoked()
    {
        string connectionString = await CreateConnectionStringAsync();
        using SqlSugarClient db = CreateDb(connectionString);
        var service = new AdminSessionValidationService(db);
        var principal = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "unit-test"));

        AdminSessionValidationResult result = await service.ValidateAsync(principal, "not-admin-token", CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("admin_principal_required", result.Reason);
    }

    [Fact]
    public async Task TouchAdminSessionAsync_StaleRowVersionAfterRevokeDoesNotAdvanceLastSeen()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "stale-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(Token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db);
        object state = await InvokeLoadAdminSessionValidationStateAsync(service, "sid-1");

        DateTime revokedAt = DateTime.UtcNow;
        await db.Updateable<AdminSession>()
            .SetColumns(session => session.RevokedAtUtc == revokedAt)
            .SetColumns(session => session.RevokeReason == "test_revoke")
            .Where(session => session.SessionId == "sid-1")
            .ExecuteCommandAsync();

        bool touched = await InvokeTryTouchAdminSessionAsync(service, state, DateTime.UtcNow);

        Assert.False(touched);
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(item => item.SessionId == "sid-1");
        Assert.Equal("test_revoke", session.RevokeReason);
        Assert.Equal(before, session.LastSeenAtUtc!.Value, TimeSpan.FromSeconds(1));
    }

    [Fact]
    public async Task ValidateAsync_RejectsRevokedSession()
    {
        await AssertRejectedAsync(session => session.RevokedAtUtc = DateTime.UtcNow, "admin_session_revoked");
    }

    [Fact]
    public async Task ValidateAsync_RejectsIdleExpiredSession()
    {
        await AssertRejectedAsync(session => session.IdleExpiresAtUtc = DateTime.UtcNow.AddSeconds(-1), "admin_session_idle_expired");
    }

    [Fact]
    public async Task ValidateAsync_RejectsAbsoluteExpiredSession()
    {
        await AssertRejectedAsync(session => session.AbsoluteExpiresAtUtc = DateTime.UtcNow.AddSeconds(-1), "admin_session_absolute_expired");
    }

    [Fact]
    public async Task ValidateAsync_RejectsDisabledPrincipal()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "disabled-principal-token";

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Disabled), CreateSession(accessTokenHash: HashForStorage(Token)));
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), Token, CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal("admin_principal_inactive", result.Reason);
    }

    [Fact]
    public async Task ValidateAsync_RejectsAccessTokenHashMismatch()
    {
        await AssertRejectedAsync(session => session.AccessTokenHash = HashForStorage("different-token"), "admin_session_token_mismatch");
    }

    private async Task AssertRejectedAsync(Action<AdminSession> mutateSession, string expectedReason)
    {
        string connectionString = await CreateConnectionStringAsync();
        const string Token = "admin-token";

        using SqlSugarClient db = CreateDb(connectionString);
        AdminSession session = CreateSession(accessTokenHash: HashForStorage(Token));
        mutateSession(session);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), session);
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), Token, CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal(expectedReason, result.Reason);
    }

    private static void Seed(SqlSugarClient db, AdminPrincipal principal, AdminSession session)
    {
        db.Insertable(principal).ExecuteCommand();
        db.Insertable(session).ExecuteCommand();
    }

    private static void CreateAdminTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(AdminPrincipal),
            typeof(AdminSession));
    }

    private static AdminPrincipal CreatePrincipal(string status)
        => new()
        {
            Id = 1,
            Handle = "root",
            Status = status,
            IsRoot = true,
            Permissions = string.Join('\n', AdminPermissions.All)
        };

    private static AdminSession CreateSession(string accessTokenHash, DateTime? lastSeenAtUtc = null)
        => new()
        {
            SessionId = "sid-1",
            AdminPrincipalId = 1,
            AccessTokenHash = accessTokenHash,
            CreatedAtUtc = DateTime.UtcNow.AddMinutes(-10),
            LastSeenAtUtc = lastSeenAtUtc ?? DateTime.UtcNow.AddMinutes(-1),
            IdleExpiresAtUtc = DateTime.UtcNow.AddMinutes(10),
            AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(1)
        };

    private static ClaimsPrincipal CreateClaimsPrincipal(long adminId, string sessionId)
        => new(new ClaimsIdentity(
        [
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", adminId.ToString()),
            new Claim("admin_sid", sessionId)
        ], "test"));

    private static string HashForStorage(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static async Task<object> InvokeLoadAdminSessionValidationStateAsync(
        AdminSessionValidationService service,
        string sessionId)
    {
        MethodInfo method = typeof(AdminSessionValidationService).GetMethod(
            "LoadAdminSessionValidationStateAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        object taskObject = method.Invoke(service, [sessionId, CancellationToken.None])!;
        await (Task)taskObject;
        object? state = taskObject.GetType().GetProperty("Result")!.GetValue(taskObject);
        return state ?? throw new InvalidOperationException("Expected validation state.");
    }

    private static async Task<bool> InvokeTryTouchAdminSessionAsync(
        AdminSessionValidationService service,
        object state,
        DateTime now)
    {
        MethodInfo method = typeof(AdminSessionValidationService).GetMethod(
            "TryTouchAdminSessionAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        object taskObject = method.Invoke(service, [state, now, CancellationToken.None])!;
        await (Task)taskObject;
        return (bool)taskObject.GetType().GetProperty("Result")!.GetValue(taskObject)!;
    }

    private static async Task<AdminSessionValidationResult> InvokeValidateCurrentSessionAfterTouchConflictAsync(
        AdminSessionValidationService service,
        long adminId,
        string sessionId,
        string currentTokenHash,
        DateTime now)
    {
        MethodInfo method = typeof(AdminSessionValidationService).GetMethod(
            "ValidateCurrentSessionAfterTouchConflictAsync",
            BindingFlags.Instance | BindingFlags.NonPublic)!;
        object taskObject = method.Invoke(service, [adminId, sessionId, currentTokenHash, now, CancellationToken.None])!;
        await (Task)taskObject;
        return (AdminSessionValidationResult)taskObject.GetType().GetProperty("Result")!.GetValue(taskObject)!;
    }

    private async Task<string> CreateConnectionStringAsync()
    {
        await s_databaseResetLock.WaitAsync();
        try
        {
            string connectionString;
            if (s_sharedConnectionString is null)
            {
                connectionString = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
                using SqlSugarClient db = CreateDb(connectionString);
                CreateAdminTables(db);
                s_sharedConnectionString = connectionString;
            }
            else
            {
                connectionString = s_sharedConnectionString;
            }

            await fixture.ExecuteAsync(
                connectionString,
                "TRUNCATE TABLE admin_session, admin_principal RESTART IDENTITY CASCADE;");
            return connectionString;
        }
        finally
        {
            s_databaseResetLock.Release();
        }
    }

    private static SqlSugarClient CreateDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);
}
