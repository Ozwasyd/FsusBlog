using System.Reflection;
using System.Runtime.CompilerServices;

using Fido2NetLib;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AdminSessionManagementTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminSessionManagementEndpoints_AreAdminManageOnlyAndClearOnlyAdminCookies()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint[] endpoints =
        [
            EndpointContractApplication.Find(app, "/api/binary/auth/admin/logout", HttpMethods.Post),
            EndpointContractApplication.Find(app, "/api/binary/auth/admin/sessions", HttpMethods.Get),
            EndpointContractApplication.Find(app, "/api/binary/auth/admin/sessions/{sessionId}/revoke", HttpMethods.Post),
            EndpointContractApplication.Find(app, "/api/binary/auth/admin/sessions/revoke-others", HttpMethods.Post)
        ];
        Assert.All(endpoints, AssertAdminManage);

        string logoutHandler = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(BinaryEndpoints),
            "LogoutAdminSessionAsync",
            "ClearAdminSessionCookies");
        Assert.Contains("LogoutAdminSessionAsync", logoutHandler, StringComparison.Ordinal);
        Assert.Contains("ClearAdminSessionCookies", logoutHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("ClearTokenCookies", logoutHandler, StringComparison.Ordinal);
        string revokeHandler = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(BinaryEndpoints),
            "RevokeAdminSessionAsync",
            "AdminSessionRevokeResult");
        Assert.Contains("admin_session_revoke_conflict", revokeHandler, StringComparison.Ordinal);
        MethodInfo revokeEndpointHandler = Assert.IsAssignableFrom<MethodInfo>(
            endpoints[2].Metadata.GetMetadata<MethodInfo>());
        AsyncStateMachineAttribute stateMachine = Assert.IsAssignableFrom<AsyncStateMachineAttribute>(
            revokeEndpointHandler.GetCustomAttribute<AsyncStateMachineAttribute>());
        MethodInfo revokeMoveNext = Assert.IsAssignableFrom<MethodInfo>(stateMachine.StateMachineType.GetMethod(
            "MoveNext",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.Contains(StatusCodes.Status409Conflict, RuntimeMetadataInspection.DescribeInt32Constants(revokeMoveNext));
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
        PropertyInfo rowVersion = Assert.IsAssignableFrom<PropertyInfo>(typeof(AdminSession).GetProperty("RowVersion"));
        Assert.Equal(typeof(string), rowVersion.PropertyType);
        SugarColumn mapping = Assert.Single(rowVersion.GetCustomAttributes<SugarColumn>());
        Assert.True(mapping.IsIgnore);
    }

    [Fact]
    public void AdminSessionRevoke_RuntimePathUsesRowVersionConflictAndAudit()
    {
        string revoke = RuntimeMetadataInspection.DescribeMethods(
            typeof(AdminPrincipalService),
            nameof(AdminPrincipalService.RevokeAdminSessionAsync),
            "LoadAdminSessionRevokeCandidateAsync",
            "TryRevokeAdminSessionAsync",
            "WriteAdminSessionRevokeAuditAsync");

        Assert.Contains("LoadAdminSessionRevokeCandidateAsync", revoke, StringComparison.Ordinal);
        Assert.Contains("TryRevokeAdminSessionAsync", revoke, StringComparison.Ordinal);
        Assert.Contains("AdminSessionRevokeResult", revoke, StringComparison.Ordinal);
        Assert.Contains("WriteAdminSessionRevokeAuditAsync", revoke, StringComparison.Ordinal);
        Assert.Contains("xmin::text = @RowVersion", revoke, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AdminSessionManagement_RuntimePathBoundsListAndBatchRevokesOthers()
    {
        int listLimit = (int)typeof(AdminPrincipalService)
            .GetField("AdminSessionListLimit", BindingFlags.Static | BindingFlags.NonPublic)!
            .GetRawConstantValue()!;
        Assert.Equal(50, listLimit);

        string list = RuntimeMetadataInspection.DescribeMethods(
            typeof(AdminPrincipalService),
            nameof(AdminPrincipalService.GetAdminSessionsAsync));
        string revokeOthers = RuntimeMetadataInspection.DescribeDeclaredMethodBodiesContaining(
            typeof(AdminPrincipalService),
            "UPDATE admin_session",
            "RETURNING sessionid",
            "WriteAdminSessionRevokeAuditsAsync");
        Assert.Contains("RecordAdminSessionList", list, StringComparison.Ordinal);
        Assert.Contains("UPDATE admin_session", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("RETURNING sessionid", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("sessionid <> @CurrentSessionId", revokeOthers, StringComparison.Ordinal);
        Assert.DoesNotContain("TryRevokeAdminSessionAsync", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("WriteAdminSessionRevokeAuditsAsync", revokeOthers, StringComparison.Ordinal);
        Assert.Contains("RecordAdminSessionRevokeOthers", revokeOthers, StringComparison.Ordinal);

        AssertMetricName("s_adminSessionListReturnedCount", "fsus.admin.session.list.returned_count");
        AssertMetricName("s_adminSessionRevokeOthersCount", "fsus.admin.session.revoke_others.count");
        AssertMetricName("s_adminSessionRevokeOthersElapsed", "fsus.admin.session.revoke_others.elapsed_ms");
    }

    private static void AssertMetricName(string fieldName, string expectedName)
    {
        FieldInfo field = Assert.IsAssignableFrom<FieldInfo>(typeof(FsusObservability).GetField(
            fieldName,
            BindingFlags.Static | BindingFlags.NonPublic));
        var instrument = Assert.IsAssignableFrom<System.Diagnostics.Metrics.Instrument>(field.GetValue(null));
        Assert.Equal(expectedName, instrument.Name);
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
            NullLogger<AdminPrincipalService>.Instance,
            new ImmediateAdminAuditLogChannel(db));

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

    private static void AssertAdminManage(RouteEndpoint endpoint)
    {
        ClaimsAuthorizationRequirement permission = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(AdminPermissions.AdminManage, permission.AllowedValues ?? []);
    }

    private sealed class ImmediateAdminAuditLogChannel(SqlSugarClient db) : IAdminAuditLogChannel
    {
        public async ValueTask EnqueueAsync(AdminAuditLog audit, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Insertable(audit).ExecuteCommandAsync();
        }

        public async ValueTask EnqueueManyAsync(IReadOnlyList<AdminAuditLog> audits, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (audits.Count > 0)
            {
                await db.Insertable(audits.ToArray()).ExecuteCommandAsync();
            }
        }
    }
}
