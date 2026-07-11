using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class AdminConsistencyContractTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task AdminTaxonomyRoutes_ExposeMethodsPermissionsAndSerializedBlockingCounts()
    {
        await using WebApplication app = CreateBinaryEndpointApplication();

        RouteEndpoint deleteTag = FindRoute(app, "/api/binary/tag/{id:int}");
        AssertMethod(deleteTag, HttpMethods.Delete);
        AssertPermission(deleteTag, AdminPermissions.ArticleWrite);

        var response = new AdminTagItemResponse(
            Id: 17,
            Name: "runtime",
            PublicArticleCount: 2,
            DraftArticleCount: 3,
            ScheduledArticleCount: 5,
            ArchivedArticleCount: 7,
            DeletedArticleCount: 11,
            TotalBlockingArticleCount: 17,
            CanDelete: false);
        using JsonDocument json = JsonDocument.Parse(JsonSerializer.Serialize(
            response,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));

        Assert.Equal(17, json.RootElement.GetProperty("totalBlockingArticleCount").GetInt32());
        Assert.False(json.RootElement.GetProperty("canDelete").GetBoolean());
    }

    [Fact]
    public async Task DeleteTagIfUnlinkedAsync_ReferencedTagKeepsTagAndArticleLink()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Tag), typeof(ArticleTag));
        int linkedTagId = await db.Insertable(new Tag { Name = $"linked-{Guid.NewGuid():N}" })
            .ExecuteReturnIdentityAsync();
        int unlinkedTagId = await db.Insertable(new Tag { Name = $"unlinked-{Guid.NewGuid():N}" })
            .ExecuteReturnIdentityAsync();
        await db.Insertable(new ArticleTag { ArticleId = 900_039, TagId = linkedTagId })
            .ExecuteCommandAsync();

        BinaryEndpoints.TagDeleteOutcome blocked = await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, linkedTagId);
        BinaryEndpoints.TagDeleteOutcome deleted = await BinaryEndpoints.DeleteTagIfUnlinkedAsync(db, unlinkedTagId);

        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.HasArticleLinks, blocked);
        Assert.NotNull(await db.Queryable<Tag>().InSingleAsync(linkedTagId));
        Assert.True(await db.Queryable<ArticleTag>().AnyAsync(link =>
            link.ArticleId == 900_039 && link.TagId == linkedTagId));
        Assert.Equal(BinaryEndpoints.TagDeleteOutcome.Deleted, deleted);
        Assert.Null(await db.Queryable<Tag>().InSingleAsync(unlinkedTagId));
    }

    [Theory]
    [InlineData(0, true)]
    [InlineData(1, true)]
    [InlineData(-1, false)]
    [InlineData(2, false)]
    public void AdminUserStatusValidation_OnlyAcceptsSuspendAndRestore(int status, bool expected)
        => Assert.Equal(expected, BinaryEndpoints.IsSupportedAdminAccountStatus(status));

    [Theory]
    [InlineData(null, false)]
    [InlineData(0, false)]
    [InlineData(-1, false)]
    [InlineData(1, true)]
    [InlineData(99, true)]
    public void SystemMessageTargetValidation_RequiresPositiveAccountId(long? accountId, bool expected)
        => Assert.Equal(expected, BinaryEndpoints.IsValidSystemMessageTarget(accountId));

    [Fact]
    public async Task StaticPageRoutes_ShareOneAllowlistAcrossPublicReadAdminReadUpdateAndRefresh()
    {
        await using WebApplication app = CreateBinaryEndpointApplication();
        RouteEndpoint publicRead = FindRoute(app, "/api/binary/system/page/{slug}");
        RouteEndpoint adminRead = FindRoute(app, "/api/binary/system/admin/page/{slug}");
        RouteEndpoint update = FindRoute(app, "/api/binary/system/page", HttpMethods.Put);
        RouteEndpoint refresh = FindRoute(app, "/api/binary/system/page/refresh/{slug}");

        AssertMethod(publicRead, HttpMethods.Get);
        AssertMethod(adminRead, HttpMethods.Get);
        AssertMethod(update, HttpMethods.Put);
        AssertMethod(refresh, HttpMethods.Post);
        AssertPermission(adminRead, AdminPermissions.SystemConfig);
        AssertPermission(update, AdminPermissions.SystemConfig);
        AssertPermission(refresh, AdminPermissions.SystemConfig);
        Assert.All(new[] { "about", "privacy", "guidelines", "copyright" }, slug =>
            Assert.True(BinaryEndpoints.IsAllowedStaticPageSlug(slug)));
        Assert.All(new string?[] { null, "", "about/extra", "terms", "隐私" }, slug =>
            Assert.False(BinaryEndpoints.IsAllowedStaticPageSlug(slug)));
    }

    private static WebApplication CreateBinaryEndpointApplication()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddAuthorization();
        builder.Services.AddOutputCache();
        WebApplication app = builder.Build();
        app.MapBinaryEndpoints();
        return app;
    }

    private static RouteEndpoint FindRoute(WebApplication app, string route, string? method = null)
    {
        IEnumerable<RouteEndpoint> matches = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(endpoint => string.Equals(
                endpoint.RoutePattern.RawText?.TrimStart('/'),
                route.TrimStart('/'),
                StringComparison.Ordinal));
        if (method is not null)
        {
            matches = matches.Where(endpoint =>
                endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods.Contains(method, StringComparer.Ordinal) == true);
        }

        return Assert.Single(matches);
    }

    private static void AssertMethod(RouteEndpoint endpoint, string method)
        => Assert.Contains(method, Assert.IsAssignableFrom<IHttpMethodMetadata>(
            endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()).HttpMethods);

    private static void AssertPermission(RouteEndpoint endpoint, string permission)
    {
        AuthorizationPolicy policy = Assert.Single(endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
        ClaimsAuthorizationRequirement requirement = Assert.Single(policy.Requirements
            .OfType<ClaimsAuthorizationRequirement>()
            .Where(item => item.ClaimType == AdminPermissions.PermissionClaimType));
        Assert.Contains(permission, requirement.AllowedValues ?? []);
    }
}
