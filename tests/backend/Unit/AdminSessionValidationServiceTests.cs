using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminSessionValidationServiceTests
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
        string dbPath = CreateTempDbPath();
        const string token = "active-admin-token";
        DateTime before = DateTime.UtcNow.AddMinutes(-5);

        using SqlSugarClient db = CreateDb(dbPath);
        Seed(db, CreatePrincipal(status: AdminPrincipalStatus.Active), CreateSession(accessTokenHash: HashForStorage(token), lastSeenAtUtc: before));
        var service = new AdminSessionValidationService(db);

        AdminSessionValidationResult result = await service.ValidateAsync(CreateClaimsPrincipal(1, "sid-1"), token, CancellationToken.None);

        Assert.True(result.IsValid, result.Reason);
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "sid-1");
        Assert.NotNull(session.LastSeenAtUtc);
        Assert.True(session.LastSeenAtUtc > before);
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
        string dbPath = CreateTempDbPath();
        const string token = "disabled-principal-token";

        using SqlSugarClient db = CreateDb(dbPath);
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

    private static async Task AssertRejectedAsync(Action<AdminSession> mutateSession, string expectedReason)
    {
        string dbPath = CreateTempDbPath();
        const string token = "admin-token";

        using SqlSugarClient db = CreateDb(dbPath);
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
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS admin_principal (
                id INTEGER PRIMARY KEY,
                handle TEXT NOT NULL,
                displayname TEXT NULL,
                status TEXT NOT NULL,
                isroot INTEGER NOT NULL,
                permissions TEXT NOT NULL,
                createdatutc TEXT NOT NULL,
                lastloginatutc TEXT NULL,
                totpenabled INTEGER NOT NULL,
                totpsecretencrypted TEXT NULL,
                totpverifiedatutc TEXT NULL
            );
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE IF NOT EXISTS admin_session (
                sessionid TEXT PRIMARY KEY,
                adminprincipalid INTEGER NOT NULL,
                accesstokenhash TEXT NOT NULL,
                devicefingerprint TEXT NULL,
                lastip TEXT NULL,
                useragent TEXT NULL,
                createdatutc TEXT NOT NULL,
                lastseenatutc TEXT NULL,
                idleexpiresatutc TEXT NOT NULL,
                absoluteexpiresatutc TEXT NOT NULL,
                revokedatutc TEXT NULL,
                revokereason TEXT NULL,
                stepupverified INTEGER NOT NULL
            );
            """);
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

    private static string CreateTempDbPath()
        => Path.Combine(Path.GetTempPath(), $"fsus-admin-session-validation-{Guid.NewGuid():N}.db");

    private static SqlSugarClient CreateDb(string dbPath)
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={dbPath}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });
}
