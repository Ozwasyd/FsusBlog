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

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class AdminSessionManagementTests(PostgresSchemaMigrationFixture fixture)
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
        Assert.Contains("AdminSessionRevokeResult.Conflict", adminBlock, StringComparison.Ordinal);
        Assert.Contains("ErrorCode.Conflict", adminBlock, StringComparison.Ordinal);
        Assert.Contains("StatusCodes.Status409Conflict", adminBlock, StringComparison.Ordinal);
    }

    [Fact]
    public async Task LogoutAdminSessionAsync_RevokesCurrentSessionWithLogoutReason()
    {
        using SqlSugarClient db = await CreateDbAsync();
        Seed(db, CreateSession("current"));
        AdminPrincipalService service = CreateService(db);

        bool loggedOut = await service.LogoutAdminSessionAsync(1, "current", CancellationToken.None);

        Assert.True(loggedOut);
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "current");
        Assert.NotNull(session.RevokedAtUtc);
        Assert.Equal("logout", session.RevokeReason);
    }

    [Fact]
    public void AdminSessionEntity_ExposesRowVersionForRevokeGuards()
    {
        Assert.True(typeof(AdminSession).GetProperty("RowVersion") is { });

        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/AdminSession.cs");
        Assert.Contains("public string? RowVersion", entity, StringComparison.Ordinal);
        Assert.Contains("[SugarColumn(IsIgnore = true)]", entity, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminSessionRevoke_SourceUsesRowVersionConflictAndAudit()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");
        string revoke = ExtractBetween(
            source,
            "public async Task<AdminSessionRevokeResult> RevokeAdminSessionAsync",
            "public async Task<int> RevokeOtherAdminSessionsAsync");

        Assert.Contains("LoadAdminSessionRevokeCandidateAsync", revoke, StringComparison.Ordinal);
        Assert.Contains("TryRevokeAdminSessionAsync(candidate", revoke, StringComparison.Ordinal);
        Assert.Contains("AdminSessionRevokeResult.Conflict", revoke, StringComparison.Ordinal);
        Assert.Contains("WriteAdminSessionRevokeAuditAsync", revoke, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", source, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AdminSessionManagement_SourceBoundsListAndBatchRevokesOthers()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");
        string observability = BackendTestPaths.ReadAllTextFromRoot("src/backend/Infrastructure/Observability/FsusObservability.cs");
        string list = ExtractBetween(
            source,
            "public async Task<IReadOnlyList<AdminSessionSummaryDto>> GetAdminSessionsAsync",
            "public async Task<bool> EnsureAdminSessionBelongsToPrincipalAsync");
        string revokeOthers = ExtractBetween(
            source,
            "public async Task<int> RevokeOtherAdminSessionsAsync",
            "private async Task<AdminSessionRevokeCandidate?> LoadAdminSessionRevokeCandidateAsync");

        Assert.Contains("AdminSessionListLimit = 50", source, StringComparison.Ordinal);
        Assert.Contains(".Take(AdminSessionListLimit)", list, StringComparison.Ordinal);
        Assert.Contains("RecordAdminSessionList", list, StringComparison.Ordinal);
        Assert.Contains("UPDATE admin_session", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("RETURNING sessionid", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("sessionid <> @CurrentSessionId", revokeOthers, StringComparison.Ordinal);
        Assert.DoesNotContain("foreach (AdminSessionRevokeCandidate", revokeOthers, StringComparison.Ordinal);
        Assert.DoesNotContain("TryRevokeAdminSessionAsync(candidate", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("WriteAdminSessionRevokeAuditsAsync", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("RecordAdminSessionRevokeOthers", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.session.list.returned_count", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.session.revoke_others.count", observability, StringComparison.Ordinal);
        Assert.Contains("fsus.admin.session.revoke_others.elapsed_ms", observability, StringComparison.Ordinal);
    }

    [Fact]
    public async Task RevokeAdminSessionAsync_RepeatedRevokeWritesOnlyOneAuditAndPreservesFirstReason()
    {
        using SqlSugarClient db = await CreateDbAsync();
        Seed(db, CreateSession("current"));
        AdminPrincipalService service = CreateService(db);

        object first = await service.RevokeAdminSessionAsync(1, "current", "logout", CancellationToken.None);
        object second = await service.RevokeAdminSessionAsync(1, "current", "forced_logout", CancellationToken.None);

        Assert.Equal("Revoked", first.ToString());
        Assert.Equal("Conflict", second.ToString());
        AdminSession session = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "current");
        Assert.Equal("logout", session.RevokeReason);
        Assert.Equal(1, await db.Queryable<AdminAuditLog>()
            .Where(log => log.AdminPrincipalId == 1 && log.AdminSessionId == "current" && log.Action == "admin.session.revoked")
            .CountAsync());
    }

    [Fact]
    public async Task RevokeOtherAdminSessionsAsync_RevokesOtherSessionsAndKeepsCurrent()
    {
        using SqlSugarClient db = await CreateDbAsync();
        Seed(db, CreateSession("current"), CreateSession("other-a"), CreateSession("other-b"), CreateSession("other-c", revoked: true));
        AdminPrincipalService service = CreateService(db);

        int revoked = await service.RevokeOtherAdminSessionsAsync(1, "current", CancellationToken.None);

        Assert.Equal(2, revoked);
        AdminSession current = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "current");
        AdminSession otherA = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "other-a");
        AdminSession otherB = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "other-b");
        AdminSession otherC = await db.Queryable<AdminSession>().SingleAsync(s => s.SessionId == "other-c");
        Assert.Null(current.RevokedAtUtc);
        Assert.NotNull(otherA.RevokedAtUtc);
        Assert.Equal("revoke_others", otherA.RevokeReason);
        Assert.NotNull(otherB.RevokedAtUtc);
        Assert.Equal("revoke_others", otherB.RevokeReason);
        Assert.NotNull(otherC.RevokedAtUtc);
        Assert.Equal(2, await db.Queryable<AdminAuditLog>()
            .Where(log => log.AdminPrincipalId == 1 && log.Action == "admin.session.revoked" && log.MetadataJson.Contains("revoke_others"))
            .CountAsync());
    }

    [Fact]
    public async Task GetAdminSessionsAsync_ReturnsCurrentAndRevokedFlags()
    {
        using SqlSugarClient db = await CreateDbAsync();
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

    [Fact]
    public async Task GetAdminSessionsAsync_ReturnsAtMostRecentFiftySessions()
    {
        using SqlSugarClient db = await CreateDbAsync();
        AdminSession[] sessions = Enumerable.Range(0, 60)
            .Select(index => CreateSession($"session-{index:00}", lastSeenAtUtc: DateTime.UtcNow.AddMinutes(-index)))
            .ToArray();
        sessions[0].SessionId = "current";
        Seed(db, sessions);
        AdminPrincipalService service = CreateService(db);

        IReadOnlyList<AdminSessionSummaryDto> result = await service.GetAdminSessionsAsync(1, "current", CancellationToken.None);

        Assert.Equal(50, result.Count);
        Assert.Contains(result, session => session.SessionId == "current" && session.IsCurrent);
        Assert.DoesNotContain(result, session => session.SessionId == "session-59");
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

    private static AdminSession CreateSession(string sessionId, bool revoked = false, DateTime? lastSeenAtUtc = null)
        => new()
        {
            SessionId = sessionId,
            AdminPrincipalId = 1,
            AccessTokenHash = sessionId,
            DeviceFingerprint = $"fp-{sessionId}",
            LastIp = "127.0.0.1",
            UserAgent = $"agent-{sessionId}",
            CreatedAtUtc = DateTime.UtcNow.AddHours(-1),
            LastSeenAtUtc = lastSeenAtUtc ?? DateTime.UtcNow.AddMinutes(-5),
            IdleExpiresAtUtc = DateTime.UtcNow.AddHours(1),
            AbsoluteExpiresAtUtc = DateTime.UtcNow.AddHours(2),
            RevokedAtUtc = revoked ? DateTime.UtcNow.AddMinutes(-1) : null,
            RevokeReason = revoked ? "existing" : null
        };

    private Task<SqlSugarClient> CreateDbAsync()
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateAdminTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(AdminPrincipal),
            typeof(AdminSession),
            typeof(AdminAuditLog));
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
