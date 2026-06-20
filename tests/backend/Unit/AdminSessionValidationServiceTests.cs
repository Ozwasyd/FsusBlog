using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
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

    private Task<string> CreateConnectionStringAsync()
        => PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);

    private static SqlSugarClient CreateDb(string connectionString)
        => PostgresSqlSugarTestClient.Create(connectionString);
}
