using System.Data;
using System.Reflection;
using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.AuthSystem;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminAnonymousAccountGovernanceContractTests
{
    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminUserEndpointSurface_ExposesListAndStatusWithoutLegacyCredentialMutation()
    {
        await using EndpointContractSnapshot app = CreateBinaryEndpointApplication();
        RouteEndpoint[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(endpoint => (endpoint.RoutePattern.RawText ?? string.Empty)
                .Contains("/admin/users", StringComparison.Ordinal))
            .ToArray();

        Assert.Collection(
            routes.OrderBy(static endpoint => endpoint.RoutePattern.RawText, StringComparer.Ordinal),
            list =>
            {
                AssertRoute(list, "/api/binary/admin/users", HttpMethods.Get);
                AssertPermission(list, AdminPermissions.AdminManage);
            },
            status =>
            {
                AssertRoute(status, "/api/binary/admin/users/status", HttpMethods.Put);
                AssertPermission(status, AdminPermissions.AdminManage);
            });
        Assert.DoesNotContain(routes, endpoint =>
            (endpoint.RoutePattern.RawText ?? string.Empty).Contains("password", StringComparison.OrdinalIgnoreCase)
            || (endpoint.RoutePattern.RawText ?? string.Empty).Contains("reset-pwd", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void AdminAccountContracts_SerializeAndRoundTripOnlyAnonymousGovernanceFields()
    {
        DateTime created = new(2026, 7, 11, 8, 0, 0, DateTimeKind.Utc);
        DateTime privacyInitialized = created.AddDays(-1);
        var dto = new AdminAccountListItemDto(
            AccountId: 37,
            IdentityKind: AnonymousIdentityRuntime.AnonymousAccountKind,
            PublicHandle: "quiet-reader",
            PasskeyInitialized: true,
            RecoveryInitialized: false,
            PrivacyInitializedAt: privacyInitialized,
            AnonymousCredentialStatus: "active",
            AnonymousCredentialLevel: "basic",
            RiskFlags: 4,
            Status: 1,
            CreateTime: created,
            DeletedAt: null);

        using JsonDocument json = JsonDocument.Parse(JsonSerializer.Serialize(
            dto,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        string[] actualFields = json.RootElement.EnumerateObject()
            .Select(static property => property.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();
        string[] expectedFields =
        [
            "accountId",
            "anonymousCredentialLevel",
            "anonymousCredentialStatus",
            "createTime",
            "deletedAt",
            "identityKind",
            "passkeyInitialized",
            "privacyInitializedAt",
            "publicHandle",
            "recoveryInitialized",
            "riskFlags",
            "status"
        ];
        Assert.Equal(expectedFields.Order(StringComparer.Ordinal), actualFields);
        Assert.DoesNotContain(actualFields, field =>
            field.Contains("password", StringComparison.OrdinalIgnoreCase)
            || field.Contains("lastLoginIp", StringComparison.OrdinalIgnoreCase)
            || field.Contains("session", StringComparison.OrdinalIgnoreCase)
            || field.Contains("device", StringComparison.OrdinalIgnoreCase)
            || field.Contains("private", StringComparison.OrdinalIgnoreCase));

        var page = new AdminUserPageContract
        {
            Total = 1,
            Items =
            [
                new AdminAccountListItemContract(
                    dto.AccountId,
                    dto.IdentityKind,
                    dto.PublicHandle,
                    dto.PasskeyInitialized,
                    dto.RecoveryInitialized,
                    dto.PrivacyInitializedAt,
                    dto.AnonymousCredentialStatus,
                    dto.AnonymousCredentialLevel,
                    dto.RiskFlags,
                    dto.Status,
                    dto.CreateTime,
                    dto.DeletedAt)
            ]
        };

        Assert.True(PodBinaryCodec.TryDecodeAdminUserPage(
            PodBinaryCodec.EncodeAdminUserPage(page),
            out AdminUserPageContract decoded));
        AdminAccountListItemContract account = Assert.Single(decoded.Items);
        Assert.Equal(37, account.AccountId);
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, account.IdentityKind);
        Assert.Equal("quiet-reader", account.PublicHandle);
        Assert.Equal("active", account.AnonymousCredentialStatus);
        Assert.Equal(4, account.RiskFlags);
    }

    [Fact]
    public async Task GetAdminUserListAsync_ExecutesPublicHandlePrefixQueryAndReturnsAnonymousFields()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var ado = Substitute.For<IAdo>();
        db.Ado.Returns(ado);
        string? executedSql = null;
        SugarParameter[]? executedParameters = null;
        DataTable table = CreateAdminAccountTable();
        ado.GetDataReaderAsync(Arg.Any<string>(), Arg.Any<SugarParameter[]>())
            .Returns(call =>
            {
                executedSql = call.ArgAt<string>(0);
                executedParameters = call.ArgAt<SugarParameter[]>(1);
                return Task.FromResult((IDataReader)table.CreateDataReader());
            });
        UserService service = CreateUserService(db);

        PageResult<AdminAccountListItemDto> result = await service.GetAdminUserListAsync(new UserQueryDto
        {
            Page = 1,
            PageSize = 20,
            Keyword = "  Quiet-Reader  ",
            Status = 1
        });

        AdminAccountListItemDto account = Assert.Single(result.Items);
        Assert.Equal(37, account.AccountId);
        Assert.Equal(AnonymousIdentityRuntime.AnonymousAccountKind, account.IdentityKind);
        Assert.Equal("quiet-reader", account.PublicHandle);
        Assert.NotNull(executedSql);
        Assert.Contains("public_handle LIKE @SearchPublicHandlePrefix", executedSql, StringComparison.Ordinal);
        Assert.DoesNotContain("username", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("password", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("lastlogin", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("role", executedSql, StringComparison.OrdinalIgnoreCase);
        Assert.Contains(executedParameters!, parameter =>
            parameter.ParameterName == "@SearchPublicHandlePrefix"
            && Equals(parameter.Value, "quiet-reader%"));
        Assert.Contains(executedParameters!, parameter =>
            parameter.ParameterName == "@Status"
            && Equals(parameter.Value, 1));
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AuthEndpointSurfaceAndApplicationPorts_DoNotExposeUsernameLookupOrPasswordReset()
    {
        await using EndpointContractSnapshot app = CreateBinaryEndpointApplication();
        string[] routes = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Select(static endpoint => endpoint.RoutePattern.RawText ?? string.Empty)
            .ToArray();

        Assert.DoesNotContain(routes, route => route.Contains("{username}", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(routes, route => route.Contains("reset-pwd", StringComparison.OrdinalIgnoreCase));
        foreach (Type port in new[]
        {
            typeof(IUserService),
            typeof(IUserCoreService),
            typeof(IUserCoreGateway)
        })
        {
            MethodInfo[] methods = port.GetMethods();
            Assert.DoesNotContain(methods, method => method.Name.Contains("Username", StringComparison.OrdinalIgnoreCase));
            Assert.DoesNotContain(methods, method => method.Name.Contains("ResetPassword", StringComparison.OrdinalIgnoreCase));
        }
    }

    private static DataTable CreateAdminAccountTable()
    {
        var table = new DataTable();
        table.Columns.Add("Id", typeof(int));
        table.Columns.Add("IdentityKind", typeof(string));
        table.Columns.Add("PublicHandle", typeof(string));
        table.Columns.Add("PasskeyEnabled", typeof(bool));
        table.Columns.Add("RecoveryEnabled", typeof(bool));
        table.Columns.Add("PrivacyInitializedAt", typeof(DateTime));
        table.Columns.Add("AnonymousCredentialStatus", typeof(string));
        table.Columns.Add("AnonymousCredentialLevel", typeof(string));
        table.Columns.Add("RiskFlags", typeof(int));
        table.Columns.Add("Status", typeof(int));
        table.Columns.Add("CreateTime", typeof(DateTime));
        table.Columns.Add("DeletedAt", typeof(DateTime));
        table.Rows.Add(
            37,
            AnonymousIdentityRuntime.AnonymousAccountKind,
            "quiet-reader",
            true,
            false,
            DateTime.UtcNow.AddDays(-2),
            "active",
            "basic",
            4,
            1,
            DateTime.UtcNow.AddDays(-3),
            DBNull.Value);
        return table;
    }

    private static UserService CreateUserService(ISqlSugarClient db)
        => new(
            _db: db,
            _logger: NullLogger<UserService>.Instance,
            _jwtHelper: Substitute.For<IJwtHelper>(),
            _cache: Substitute.For<IUnifiedCache>(),
            _blacklistService: Substitute.For<IBlacklistService>(),
            _messageCommandService: Substitute.For<IMessageCommandService>(),
            _messageRealtimePublisher: Substitute.For<IMessageRealtimePublisher>(),
            _totpService: Substitute.For<ITotpService>(),
            _authRiskService: Substitute.For<IAuthRiskService>(),
            _userSessionValidationCache: Substitute.For<IUserSessionValidationCache>());

    private static EndpointContractSnapshot CreateBinaryEndpointApplication()
        => EndpointContractApplication.CreateSnapshot();

    private static void AssertRoute(RouteEndpoint endpoint, string route, string method)
    {
        Assert.Equal(route.TrimStart('/'), endpoint.RoutePattern.RawText?.TrimStart('/'));
        Assert.Contains(method, Assert.IsAssignableFrom<IHttpMethodMetadata>(
            endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()).HttpMethods);
    }

    private static void AssertPermission(RouteEndpoint endpoint, string permission)
    {
        AuthorizationPolicy policy = Assert.Single(endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
        ClaimsAuthorizationRequirement requirement = Assert.Single(policy.Requirements
            .OfType<ClaimsAuthorizationRequirement>(),
            item => item.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(permission, requirement.AllowedValues ?? []);
    }
}
