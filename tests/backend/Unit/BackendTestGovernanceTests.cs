using System.Text.Json.Nodes;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
namespace FsusBlog.Server.Tests.Unit;

public sealed class BackendTestGovernanceTests
{
    private const string RequirementsFixturePath = "tests/backend/Fixtures/backend-test-requirements.json";
    private const string EvidenceAuthorityFixturePath =
        "tests/backend/Fixtures/backend-evidence-path-authority.generated.json";

    [Fact]
    public void Issue40Profiles_HaveCommandsRequirementsAndEvidence()
    {
        JsonArray profiles = ReadRequirementsFixture()["profiles"]!.AsArray();
        var requirementIds = ReadRequirementsFixture()["requirements"]!
            .AsArray()
            .Select(static node => node!["id"]!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);

        Assert.True(profiles.Count >= 10);

        foreach (JsonObject profile in profiles.Select(static node => node!.AsObject()))
        {
            string profileId = profile["id"]!.GetValue<string>();
            Assert.True(
                profileId.StartsWith("backend-", StringComparison.Ordinal)
                || profileId.StartsWith("distributed-contract-", StringComparison.Ordinal)
                || string.Equals(profileId, "legacy-20260517-real-dump", StringComparison.Ordinal),
                $"profile id must be a governed backend or distributed-contract lane: {profileId}");
            string command = profile["command"]!.GetValue<string>();
            Assert.True(
                command.StartsWith("tools/test/", StringComparison.Ordinal)
                || command.StartsWith("node tools/test/", StringComparison.Ordinal),
                $"profile command must use a governed tools/test entrypoint: {command}");
            Assert.False(string.IsNullOrWhiteSpace(profile["risk"]!.GetValue<string>()));

            JsonArray requirements = profile["requirements"]!.AsArray();
            Assert.NotEmpty(requirements);
            foreach (JsonNode? requirement in requirements)
            {
                Assert.Contains(requirement!.GetValue<string>(), requirementIds);
            }

            AssertEvidencePathsExist(profile["evidencePaths"]!.AsArray());
        }
    }

    [Fact]
    public void Issue40Requirements_HaveEvidenceAndRiskTraceability()
    {
        JsonArray requirements = ReadRequirementsFixture()["requirements"]!.AsArray();
        var ids = new HashSet<string>(StringComparer.Ordinal);

        Assert.True(requirements.Count >= 30);
        foreach (JsonObject requirement in requirements.Select(static node => node!.AsObject()))
        {
            string id = requirement["id"]!.GetValue<string>();
            Assert.True(ids.Add(id), $"duplicate backend requirement {id}");
            Assert.StartsWith("BACKEND-", id, StringComparison.Ordinal);
            Assert.False(string.IsNullOrWhiteSpace(requirement["risk"]!.GetValue<string>()));
            Assert.False(string.IsNullOrWhiteSpace(requirement["coverage"]!.GetValue<string>()));
            AssertEvidencePathsExist(requirement["evidencePaths"]!.AsArray());
        }
    }

    [Fact]
    public async Task EndpointFamilies_CoverEveryRuntimeRouteAndMethod()
    {
        JsonObject fixture = ReadRequirementsFixture();
        var knownRequirements = fixture["requirements"]!
            .AsArray()
            .Select(static node => node!["id"]!.GetValue<string>())
            .ToHashSet(StringComparer.Ordinal);
        EndpointFamilyContract[] families = fixture["endpointFamilies"]!
            .AsArray()
            .Select(static node => EndpointFamilyContract.From(node!.AsObject()))
            .ToArray();
        Assert.NotEmpty(families);
        Assert.Equal(families.Length, families.Select(static family => family.Id).Distinct(StringComparer.Ordinal).Count());
        Assert.All(families, family =>
        {
            Assert.False(string.IsNullOrWhiteSpace(family.Id));
            Assert.True(family.RoutePrefixes.Length + family.RoutePatterns.Length > 0);
            Assert.NotEmpty(family.Requirements);
            Assert.All(family.Requirements, requirement => Assert.Contains(requirement, knownRequirements));
        });

        WebApplicationBuilder mainBuilder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Development
        });
        mainBuilder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["fsus:allowLocalAuthFixture"] = "true"
        });
        EndpointContractApplication.AddContractServices(mainBuilder);
        await using WebApplication main = mainBuilder.Build();
        MapGovernedEndpoints(main);

        WebApplicationBuilder qualificationBuilder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = "Test"
        });
        qualificationBuilder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["SchemaMigration:QualificationEnabled"] = "true"
        });
        EndpointContractApplication.AddContractServices(qualificationBuilder);
        await using WebApplication qualification = qualificationBuilder.Build();
        qualification.MapReleaseSchemaQualificationEndpoints();

        RouteEndpoint[] runtimeEndpoints = ((IEndpointRouteBuilder)main).DataSources
            .Concat(((IEndpointRouteBuilder)qualification).DataSources)
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .ToArray();
        Assert.NotEmpty(runtimeEndpoints);

        var routeMethods = new List<string>();
        foreach (RouteEndpoint endpoint in runtimeEndpoints)
        {
            string route = NormalizeRoute(endpoint.RoutePattern.RawText);
            string[] methods = endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()?.HttpMethods
                .Order(StringComparer.Ordinal)
                .ToArray() ?? [];
            Assert.NotEmpty(methods);
            EndpointFamilyContract[] matches = families.Where(family => family.Matches(route)).ToArray();
            Assert.True(
                matches.Length > 0,
                $"runtime endpoint {string.Join(',', methods)} {route} is not assigned to an endpoint family");
            string[] tags = endpoint.Metadata.GetMetadata<ITagsMetadata>()?.Tags.ToArray() ?? [];
            string? routeKind = endpoint.Metadata.GetMetadata<FsusRouteKindMetadata>()?.RouteKind;
            Assert.True(
                tags.Length > 0 || !string.IsNullOrWhiteSpace(routeKind) || matches.Length > 0,
                $"runtime endpoint {route} is missing tag or family metadata");
            routeMethods.AddRange(methods.Select(method => $"{method} {route}"));
        }

        Assert.Equal(routeMethods.Count, routeMethods.Distinct(StringComparer.Ordinal).Count());
        Assert.All(
            families,
            family => Assert.Contains(runtimeEndpoints, endpoint => family.Matches(NormalizeRoute(endpoint.RoutePattern.RawText))));
    }

    private static void MapGovernedEndpoints(WebApplication app)
    {
        app.MapBinaryEndpoints();
        app.MapAuthoringEndpoints();
        app.MapSecurityEndpoints();
        app.MapAdminIntegrityConsoleEndpoints();
        app.MapPublicAotEndpoints();
        app.MapDistributionEndpoints();
        app.MapIntegrityVerificationEndpoints();
        app.MapLocalAuthFixtureEndpoints();
        app.MapNotificationStreamDrillEndpoints();
    }

    private static string NormalizeRoute(string? route)
        => string.Concat('/', (route ?? string.Empty).Trim().TrimStart('/'));

    private sealed record EndpointFamilyContract(
        string Id,
        string[] RoutePrefixes,
        string[] RoutePatterns,
        string[] Requirements)
    {
        public static EndpointFamilyContract From(JsonObject value)
            => new(
                value["id"]!.GetValue<string>(),
                ReadValues(value, "routePrefixes"),
                ReadValues(value, "routePatterns"),
                ReadValues(value, "requirements"));

        public bool Matches(string route)
            => RoutePatterns.Contains(route, StringComparer.Ordinal)
                || RoutePrefixes.Any(prefix => string.Equals(route, prefix, StringComparison.Ordinal)
                    || route.StartsWith(string.Concat(prefix, '/'), StringComparison.Ordinal));

        private static string[] ReadValues(JsonObject value, string property)
            => value[property]?.AsArray()
                .Select(static node => node!.GetValue<string>())
                .ToArray() ?? [];
    }

    private static void AssertEvidencePathsExist(JsonArray paths)
    {
        Assert.NotEmpty(paths);
        foreach (JsonNode? path in paths)
        {
            string relativePath = path!.GetValue<string>();
            if (relativePath.StartsWith(".tmp/", StringComparison.Ordinal))
            {
                JsonArray entries = BackendTestPaths.ReadJsonFromRoot(EvidenceAuthorityFixturePath)["entries"]!.AsArray();
                JsonObject authority = Assert.Single(
                    entries.Select(static entry => entry!.AsObject()),
                    entry => string.Equals(
                        entry["evidencePath"]!.GetValue<string>(),
                        relativePath,
                        StringComparison.Ordinal));
                Assert.NotEmpty(authority["owners"]!.AsArray());
                continue;
            }

            string fullPath = BackendTestPaths.FromRoot(relativePath);
            Assert.True(File.Exists(fullPath) || Directory.Exists(fullPath), $"missing evidence path {relativePath}");
        }
    }

    private static JsonObject ReadRequirementsFixture()
        => BackendTestPaths.ReadJsonFromRoot(RequirementsFixturePath);
}
