using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class AdminSessionValidationServiceTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public void JwtBearerEvents_ValidateAdminSessionAfterTokenSignature()
    {
        string jwt = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Helpers/JwtHelper.cs");

        Assert.Contains("OnTokenValidated", jwt, StringComparison.Ordinal);
        Assert.Contains("IAdminSessionValidationService", jwt, StringComparison.Ordinal);
        Assert.Contains("ValidateAsync(context.Principal", jwt, StringComparison.Ordinal);
        Assert.Contains("ClearAdminSessionCookies", jwt, StringComparison.Ordinal);
        Assert.Contains("context.Fail", jwt, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ValidateAsync_AllowsActiveSessionAndUpdatesLastSeen()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string token = "active-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), token, CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "sid-1");
        Assert.NotNull(session.LastSeenAtUtc);
        Assert.True(session.LastSeenAtUtc > before);
    }

    [Fact]
    public async Task ValidateCurrentSessionAfterTouchConflict_AllowsConcurrentLastSeenUpdate()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string token = "concurrent-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db);

        await db.Updateable<AdminSession>()
            .SetColumns(session => session.LastSeenAtUtc == DateTime.UtcNow)
            .Where(session => session.SessionId == "sid-1")
            .ExecuteCommandAsync();

        AdminSessionValidationResult result = await InvokeValidateCurrentSessionAfterTouchConflictAsync(
            service,
            adminId: 1,
            sessionId: "sid-1",
            currentTokenHash: HashForStorage(token),
            now: DateTime.UtcNow);

        Assert.True(result.IsValid, result.Reason);
    }

    [Fact]
    public void ValidateAsync_SourceUsesRowVersionGuardForLastSeenTouch()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminSessionValidationService.cs");

        Assert.Contains("LoadAdminSessionValidationStateAsync", source, StringComparison.Ordinal);
        Assert.Contains("TryTouchAdminSessionAsync(session, now", source, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND accesstokenhash = @AccessTokenHash", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND idleexpiresatutc = @IdleExpiresAtUtc", source, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("ValidateCurrentSessionAfterTouchConflictAsync", source, StringComparison.Ordinal);
        Assert.DoesNotContain("Invalid(\"admin_session_conflict\")", source, StringComparison.Ordinal);
        Assert.DoesNotContain(".Where(s => s.SessionId == sessionId && s.RevokedAtUtc == null)", source, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TouchAdminSessionAsync_StaleRowVersionAfterRevokeDoesNotAdvanceLastSeen()
    {
        string connectionString = await CreateConnectionStringAsync();
        const string token = "stale-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(token), lastSeenAtUtc: before));
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
        const string token = "disabled-principal-token";

        using SqlSugarClient db = CreateDb(connectionString);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Disabled), CreateSession(accessTokenHash: HashForStorage(token)));
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), token, CancellationToken.None);

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
        const string token = "admin-token";

        using SqlSugarClient db = CreateDb(connectionString);
        AdminSession session = CreateSession(accessTokenHash: HashForStorage(token));
        mutateSession(session);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), session);
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), token, CancellationToken.None);

        Assert.False(result.IsValid);
        Assert.Equal(expectedReason, result.Reason);
    }

    private static void Seed(SqlSugarClient db, AdminPrincipal principal, AdminSession session)
    {
        CreateAdminTables(db);
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

    private Task<string> CreateConnectionStringAsync()
        => PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);

    private static SqlSugarClient CreateDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);
}
