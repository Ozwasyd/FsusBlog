using Fido2NetLib;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminSessionManagementTests
{
    [Fact]
    public void AdminSessionManagementEndpoints_AreAdminManageOnlyAndClearOnlyAdminCookies()
    {
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Auth.cs");

        Assert.Contains("MapPost(\"/auth/admin/logout\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/auth/admin/sessions\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/auth/admin/sessions/{sessionId}/revoke\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/auth/admin/sessions/revoke-others\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("LogoutAdminSessionAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("ClearAdminSessionCookies", endpoints, StringComparison.Ordinal);

        string adminBlock = ExtractBetween(
            endpoints,
            "MapPost(\"/auth/admin/logout\"",
            "group.MapGet(\"/auth/me\"");
        Assert.Contains(".RequireAdminPermission(AdminPermissions.AdminManage)", adminBlock, StringComparison.Ordinal);
        Assert.DoesNotContain("ClearTokenCookies", adminBlock, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LogoutAdminSessionAsync_RevokesCurrentSessionWithLogoutReason()
    {
        using SqlSugarClient db = CreateDb();
        Seed(db, CreateSession("current"));
        AdminPrincipalService service = CreateService(db);

        bool loggedOut = await service.LogoutAdminSessionAsync(1, "current", CancellationToken.None);

        Assert.True(loggedOut);
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "current");
        Assert.NotNull(session.RevokedAtUtc);
        Assert.Equal("logout", session.RevokeReason);
    }

    [Fact]
    public async Task RevokeOtherAdminSessionsAsync_RevokesOtherSessionsAndKeepsCurrent()
    {
        using SqlSugarClient db = CreateDb();
        Seed(db, CreateSession("current"), CreateSession("other-a"), CreateSession("other-b", revoked: true));
        AdminPrincipalService service = CreateService(db);

        int revoked = await service.RevokeOtherAdminSessionsAsync(1, "current", CancellationToken.None);

        Assert.Equal(1, revoked);
        AdminSession current = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "current");
        AdminSession otherA = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "other-a");
        AdminSession otherB = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "other-b");
        Assert.Null(current.RevokedAtUtc);
        Assert.NotNull(otherA.RevokedAtUtc);
        Assert.Equal("revoke_others", otherA.RevokeReason);
        Assert.NotNull(otherB.RevokedAtUtc);
    }

    [Fact]
    public async Task GetAdminSessionsAsync_ReturnsCurrentAndRevokedFlags()
    {
        using SqlSugarClient db = CreateDb();
        Seed(db, CreateSession("current"), CreateSession("revoked", revoked: true));
        AdminPrincipalService service = CreateService(db);

        IReadOnlyList<AdminSessionSummaryDto> sessions = await service.GetAdminSessionsAsync(1, "current", CancellationToken.None);

        Assert.Equal(2, sessions.Count);
        AdminSessionSummaryDto current = Assert.Single(sessions, s => s.SessionId == "current");
        AdminSessionSummaryDto revoked = Assert.Single(sessions, s => s.SessionId == "revoked");
        Assert.True(current.IsCurrent);
        Assert.False(current.IsRevoked);
        Assert.False(revoked.IsCurrent);
        Assert.True(revoked.IsRevoked);
        Assert.NotEqual(default, current.CreatedAtUtc);
        Assert.NotEqual(default, current.IdleExpiresAtUtc);
        Assert.NotEqual(default, current.AbsoluteExpiresAtUtc);
    }

    private static AdminPrincipalService CreateService(SqlSugarClient db)
        => new(
            Substitute.For<IFido2>(),
            db,
            Substitute.For<IUnifiedCache>(),
            Substitute.For<IJwtHelper>(),
            new ConfigurationBuilder().Build(),
            NullLogger<AdminPrincipalService>.Instance);

    private static void Seed(SqlSugarClient db, params AdminSession[] sessions)
    {
        CreateAdminTables(db);
        db.Insertable(new AdminPrincipal
        {
            Id = 1,
            Handle = "root",
            Status = AdminPrincipalStatus.Active,
            IsRoot = true,
            Permissions = string.Join('\n', AdminPermissions.All)
        }).ExecuteCommand();
        foreach (AdminSession session in sessions)
        {
            db.Insertable(session).ExecuteCommand();
        }
    }

    private static AdminSession CreateSession(string sessionId, bool revoked = false)
        => new()
        {
            SessionId = sessionId,
            AdminPrincipalId = 1,
            AccessTokenHash = sessionId,
            DeviceFingerprint = $"fp-{sessionId}",
            LastIp = "127.0.0.1",
            UserAgent = $"agent-{sessionId}",
            CreatedAtUtc = DateTime.UtcNow.AddHours(-1),
            LastSeenAtUtc = DateTime.UtcNow.AddMinutes(-5),
            IdleExpiresAtUtc = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(2),
            RevokedAtUtc = revoked ? DateTime.UtcNow.AddMinutes(-1) : null,
            RevokeReason = revoked ? "existing" : null
        };

    private static SqlSugarClient CreateDb()
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={Path.Combine(Path.GetTempPath(), $"fsus-admin-session-management-{Guid.NewGuid():N}.db")}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

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

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }
}
