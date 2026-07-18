using System.Net;
using System.Text.Json.Nodes;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Validation;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.Routing;

using CoreFrameType = FsusBlog.Core.Algorithms.AedsFrameType;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "ApiIntegration")]
public sealed class BackendApiIntegrationContractTests
{
    [Fact]
    public void BinaryEndpointFrameTypes_AreCoveredByAedsGoldenCatalog()
    {
        JsonObject catalog = ReadJson("tests/backend/Fixtures/aeds-golden-catalog.json");
        Dictionary<string, int> goldenFrames = catalog["frames"]!
            .AsArray()
            .Select(static node => node!.AsObject())
            .ToDictionary(
                static frame => frame["name"]!.GetValue<string>(),
                static frame => frame["value"]!.GetValue<int>(),
                StringComparer.Ordinal);

        CoreFrameType[] generatedFrames = Enum.GetValues<CoreFrameType>();
        Assert.Equal(generatedFrames.Length, goldenFrames.Count);
        Assert.All(generatedFrames, frame =>
        {
            string name = frame.ToString();
            Assert.True(goldenFrames.TryGetValue(name, out int value), $"missing golden frame {name}");
            Assert.Equal((ushort)frame, value);
            Assert.Equal((ushort)frame, AedsProtocolMetadata.FrameTypes[name]);
        });
    }

    [Fact]
    public void EndpointFamilies_ReferenceKnownIssue40Requirements()
    {
        JsonObject catalog = ReadJson("tests/backend/Fixtures/backend-test-requirements.json");
        var knownRequirements = catalog["requirements"]!
            .AsArray()
            .Select(static node => node!["id"]!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);

        foreach (JsonObject endpoint in catalog["endpointFamilies"]!
            .AsArray()
            .Select(static node => node!.AsObject()))
        {
            Assert.False(string.IsNullOrWhiteSpace(endpoint["id"]!.GetValue<string>()));
            int matcherCount = (endpoint["routePrefixes"]?.AsArray().Count ?? 0)
                + (endpoint["routePatterns"]?.AsArray().Count ?? 0);
            Assert.True(matcherCount > 0);
            JsonArray requirements = endpoint["requirements"]!.AsArray();
            Assert.NotEmpty(requirements);
            Assert.All(requirements, requirement =>
                Assert.Contains(requirement!.GetValue<string>(), knownRequirements));
        }
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task BinaryAdminMutationFiles_RetainAuthorizationAndPowBoundaries()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint adminCreate = EndpointContractApplication.Find(
            app,
            "/api/binary/admin/article",
            HttpMethods.Post);
        AssertPermission(adminCreate, AdminPermissions.ArticleWrite);
        Assert.Equal(
            new[] { typeof(RequiresPowFilter) },
            adminCreate.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
                .Select(static metadata => metadata.FilterType)
                .ToArray());

    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task PublicRelatedReadingBinaryEndpoint_RetainsPublicReadBoundariesAndApiError()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint related = EndpointContractApplication.Find(
            app,
            "/api/binary/article/{articleId:int}/related.aeds",
            HttpMethods.Get);
        Assert.NotNull(related.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.Equal(
            "public_read",
            Assert.IsType<EnableRateLimitingAttribute>(
                related.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        Assert.Equal(
            new RiskActionEndpointMetadata(RiskActionNames.PublicRead, "article.related"),
            related.Metadata.GetMetadata<RiskActionEndpointMetadata>());
        Assert.Equal(
            new[] { typeof(RiskAwarePublicReadFilter) },
            related.Metadata.GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
                .Select(static metadata => metadata.FilterType)
                .ToArray());
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task PublicReadRiskAwareBinaryEndpoints_RetainRiskActionMetadata()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();

        RouteEndpoint[] publicReadEndpoints = ((IEndpointRouteBuilder)app).DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => endpoint.Metadata
                .GetOrderedMetadata<EndpointFilterBoundaryMetadata>()
                .Any(static metadata => metadata.FilterType == typeof(RiskAwarePublicReadFilter)))
            .ToArray();

        Assert.NotEmpty(publicReadEndpoints);
        Assert.All(publicReadEndpoints, endpoint =>
        {
            RiskActionEndpointMetadata risk = Assert.IsType<RiskActionEndpointMetadata>(
                endpoint.Metadata.GetMetadata<RiskActionEndpointMetadata>());
            Assert.Equal(RiskActionNames.PublicRead, risk.ActionName);
            Assert.False(string.IsNullOrWhiteSpace(risk.RouteKey));
            Assert.Equal(
                "public_read",
                Assert.IsType<EnableRateLimitingAttribute>(
                    endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);
        });
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task HumanReadProofBinaryEndpoints_RetainSecurityBoundariesAndApiError()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create();
        using HttpClient client = server.CreateClient();

        foreach (string route in new[]
        {
            "/api/binary/read-proof/challenge.aeds",
            "/api/binary/read-proof/submit.aeds"
        })
        {
            RouteEndpoint endpoint = EndpointContractApplication.Find(app, route, HttpMethods.Post);
            Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
            Assert.Equal(
                "read_proof",
                Assert.IsType<EnableRateLimitingAttribute>(
                    endpoint.Metadata.GetMetadata<EnableRateLimitingAttribute>()).PolicyName);

            using var request = new HttpRequestMessage(HttpMethod.Post, route);
            request.Headers.Accept.ParseAdd("application/json");
            using HttpResponseMessage response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.NotAcceptable, response.StatusCode);
            Assert.Equal(
                "binary_accept_required",
                (await EndpointSecurityTestServer.ReadErrorAsync(response)).Message);
        }
    }

    [Fact]
    public async Task BinaryAdminArticleListEndpoint_RejectsInvalidPaginationInsteadOfCoercing()
    {
        using EndpointSecurityTestServer server = EndpointSecurityTestServer.Create();
        using HttpClient client = server.CreateClient();
        using var request = new HttpRequestMessage(
            HttpMethod.Get,
            "/api/binary/admin/article?page=0&size=101");
        EndpointSecurityTestServer.AddAdminPrincipal(request, AdminPermissions.ArticleWrite);

        using HttpResponseMessage response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        ErrorDetail error = await EndpointSecurityTestServer.ReadErrorAsync(response);
        Assert.Equal(ErrorCode.Validation, error.Code);
        Assert.Contains("分页", error.Message, StringComparison.Ordinal);
    }

    private static void AssertPermission(RouteEndpoint endpoint, string permission)
    {
        AuthorizationPolicy[] policies = endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>().ToArray();
        Assert.Contains(
            policies.SelectMany(static policy => policy.Requirements),
            static requirement => requirement is DenyAnonymousAuthorizationRequirement);
        ClaimsAuthorizationRequirement claim = Assert.Single(policies
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(permission, claim.AllowedValues ?? []);
    }

    private static JsonObject ReadJson(string path)
        => BackendTestPaths.ReadJsonFromRoot(path);
}
