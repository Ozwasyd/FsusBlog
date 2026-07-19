using System.Reflection;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed partial class ArchitectureMaintainabilityBehaviorTests
{
    private const string AuthoringPrefix = "/api/binary/author";

    [Fact]
    public void WebApplicationCompositionRoot_ContainsAssemblyOnly()
    {
        string composition = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Bootstrap", "WebApplicationCompositionExtensions.cs");
        string runtime = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Bootstrap", "PublicWebRuntime.cs");
        string materialization = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Bootstrap", "PublicWebRuntime.HtmlMaterialization.cs");

        Assert.Contains("UseFsusApplicationPipeline", composition, StringComparison.Ordinal);
        Assert.Contains("MapFsusApplicationRoutes", composition, StringComparison.Ordinal);
        Assert.Contains("PipelineStage", composition, StringComparison.Ordinal);
        Assert.Contains("PublicWebRuntime.ReportHttp3TransportStartup", composition, StringComparison.Ordinal);

        foreach (string forbidden in new[]
        {
            "HttpContext",
            "Results.",
            "TypedResults.",
            "Encoding.",
            "BodyWriter",
            "BuildHtmlCsp",
            "IsKnownSpaRoute",
            "TryBuildTrailingSlashRedirect",
            "RenderClassifiedAsync",
            "GetRequiredService<",
            "IServiceProvider"
        })
        {
            Assert.DoesNotContain(forbidden, composition, StringComparison.Ordinal);
        }

        Assert.Contains("ServePublicShellOrIndexAsync", runtime, StringComparison.Ordinal);
        Assert.Contains("WritePublicStatusHtmlAsync", runtime, StringComparison.Ordinal);
        Assert.Contains("WriteSpaHtmlResponseAsync", materialization, StringComparison.Ordinal);
    }

    [Fact]
    public void RuntimeServiceRegistrationRoots_DoNotExecuteUseCasesOrMaterializeResponses()
    {
        string infrastructure = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Bootstrap", "RuntimeInfrastructureServiceCollectionExtensions.cs");
        string domain = BackendTestPaths.ReadAllTextFromRoot(
            "src", "backend", "Infrastructure", "Bootstrap", "RuntimeDomainServiceCollectionExtensions.cs");
        string registrations = string.Concat(infrastructure, "\n", domain);

        foreach (string forbidden in new[]
        {
            "BuildServiceProvider(",
            "HttpContext",
            "Results.",
            "TypedResults.",
            "MapGet(",
            "MapPost(",
            "BodyWriter",
            "RenderClassifiedAsync(",
            "ExecuteAsync("
        })
        {
            Assert.DoesNotContain(forbidden, registrations, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void SplitRuntimeServices_PreserveServiceContractsAndDependencyInjectionLifetimes()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        EndpointContractApplication.AddContractServices(builder);
        IServiceCollection services = builder.Services;

        AssertRegistration<ISearchIndexService, SearchIndexService>(services, ServiceLifetime.Singleton);
        AssertRegistration<ArticleService, ArticleService>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringAnalyticsReader>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringAssetQuery>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringAssetCommands>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringDraftLifecycle>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringPrepublishPolicy>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringContentExport>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringContentImport>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringAiAssist>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringModerationQueue>(services, ServiceLifetime.Scoped);
        AssertFactoryRegistration<IAuthoringModerationCommands>(services, ServiceLifetime.Scoped);
        AssertRegistration<ISchemaMigrationRegistry, SchemaMigrationRegistry>(services, ServiceLifetime.Singleton);
        AssertRegistration<PublicHotReadStore, PublicHotReadStore>(services, ServiceLifetime.Singleton);
        AssertRegistration<PublicHotReadCounters, PublicHotReadCounters>(services, ServiceLifetime.Singleton);

        Assert.True(typeof(ISearchIndexService).IsAssignableFrom(typeof(SearchIndexService)));
        Assert.True(typeof(FsusBlog.Core.Services.Gateways.IArticleCoreGateway).IsAssignableFrom(typeof(ArticleService)));
    }

    [Fact]
    public void AuthoringUseCases_AreSplitIntoNarrowEndpointPorts()
    {
        Type[] ports =
        [
            typeof(IAuthoringAnalyticsReader),
            typeof(IAuthoringAssetQuery),
            typeof(IAuthoringAssetCommands),
            typeof(IAuthoringDraftLifecycle),
            typeof(IAuthoringPrepublishPolicy),
            typeof(IAuthoringContentExport),
            typeof(IAuthoringContentImport),
            typeof(IAuthoringAiAssist),
            typeof(IAuthoringModerationQueue),
            typeof(IAuthoringModerationCommands)
        ];
        string[] methodNames = ports
            .SelectMany(static port => port.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly))
            .Where(static method => !method.IsSpecialName)
            .Select(static method => method.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
        [
            "CleanupOrphanAssetsAsync",
            "DiscardDraftAsync",
            "ExportArticleAsync",
            "ExportContentBackupAsync",
            "GenerateAiAssist",
            "GenerateAiAssist",
            "GetAnalyticsAsync",
            "GetDraftAsync",
            "GetRevisionAsync",
            "GetRevisionsAsync",
            "ImportArticleAsync",
            "ListAssetsAsync",
            "ListCommentModerationQueueAsync",
            "ModerateCommentAsync",
            "ModerateCommentsAsync",
            "PreviewAsync",
            "ReindexAssetsAsync",
            "RollbackRevisionAsync",
            "RunPrepublishCheck",
            "SaveDraftAsync"
        ], methodNames);

        string backendRoot = BackendTestPaths.FromRoot("src/backend");
        string[] productionFiles = Directory.GetFiles(backendRoot, "*.cs", SearchOption.AllDirectories);
        Assert.DoesNotContain(productionFiles, path => File.ReadAllText(path).Contains("AuthoringWorkflowService", StringComparison.Ordinal));
        string endpoints = string.Join('\n', productionFiles
            .Where(static path => Path.GetFileName(path).StartsWith("AuthoringEndpoints", StringComparison.Ordinal))
            .Select(File.ReadAllText));
        Assert.DoesNotContain("AuthoringAnalyticsReadService service", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthoringAssetLibraryService service", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthoringDraftLifecycleService service", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthoringContentTransferService service", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthoringModerationWorkflowService service", endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain("IServiceProvider", string.Join('\n', productionFiles
            .Where(static path => path.Contains("/Services/Authoring/", StringComparison.Ordinal))
            .Select(File.ReadAllText)), StringComparison.Ordinal);

        var implementations = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [nameof(AuthoringAnalyticsReadService)] = File.ReadAllText(Path.Combine(backendRoot, "Services/Authoring/AuthoringAnalyticsReadService.cs")),
            [nameof(AuthoringAssetLibraryService)] = File.ReadAllText(Path.Combine(backendRoot, "Services/Authoring/AuthoringAssetLibraryService.cs")),
            [nameof(AuthoringDraftLifecycleService)] = File.ReadAllText(Path.Combine(backendRoot, "Services/Authoring/AuthoringDraftLifecycleService.cs")),
            [nameof(AuthoringContentTransferService)] = File.ReadAllText(Path.Combine(backendRoot, "Services/Authoring/AuthoringContentTransferService.cs")),
            [nameof(AuthoringModerationWorkflowService)] = File.ReadAllText(Path.Combine(backendRoot, "Services/Authoring/AuthoringModerationWorkflowService.cs"))
        };
        foreach ((string owner, string source) in implementations)
        {
            Assert.DoesNotContain(
                implementations.Keys.Where(candidate => !string.Equals(candidate, owner, StringComparison.Ordinal)),
                source.Contains);
        }
    }

    [Fact]
    public void AuthoringEndpointSlices_PreserveCompleteRuntimeRouteCodecAndPermissionTopology()
    {
        using EndpointContractSnapshot snapshot = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint[] endpoints = snapshot.DataSources
            .SelectMany(static source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .Where(static endpoint => (endpoint.RoutePattern.RawText ?? string.Empty)
                .StartsWith(AuthoringPrefix, StringComparison.Ordinal))
            .OrderBy(static endpoint => endpoint.RoutePattern.RawText, StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(58, endpoints.Length);
        foreach (RouteEndpoint endpoint in endpoints)
        {
            string rawPath = Assert.IsType<string>(endpoint.RoutePattern.RawText);
            string method = Assert.Single(
                Assert.IsAssignableFrom<IHttpMethodMetadata>(
                    endpoint.Metadata.GetMetadata<IHttpMethodMetadata>()).HttpMethods);
            ITagsMetadata tags = Assert.IsAssignableFrom<ITagsMetadata>(
                endpoint.Metadata.GetMetadata<ITagsMetadata>());
            Assert.Contains("Authoring", tags.Tags);

            AuthorizationPolicy policy = Assert.Single(
                endpoint.Metadata.GetOrderedMetadata<AuthorizationPolicy>());
            ClaimsAuthorizationRequirement permission = Assert.Single(
                policy.Requirements.OfType<ClaimsAuthorizationRequirement>(),
                static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
            Assert.NotEmpty(permission.AllowedValues ?? []);

            string concretePath = MaterializeRoute(rawPath);
            Assert.StartsWith(AuthoringPrefix, concretePath, StringComparison.Ordinal);
            var remaining = new PathString(concretePath[AuthoringPrefix.Length..]);
            Assert.True(
                AuthoringEndpoints.TryResolveRoute(method, remaining, out AuthoringEndpoints.AuthoringAedsRoute route),
                $"missing AEDS codec contract for {method} {rawPath} ({concretePath})");
            Assert.NotEqual(default, route.ResponseFrame);
        }
    }

    private static string MaterializeRoute(string rawPath)
        => RouteParameterRegex().Replace(rawPath, static match =>
        {
            string name = match.Groups["name"].Value;
            return name switch
            {
                "dictionaryId" => "global.test",
                "draftKey" => "draft-key",
                "regionCode" => "CN",
                _ => "42"
            };
        });

    private static void AssertRegistration<TService, TImplementation>(
        IServiceCollection services,
        ServiceLifetime expectedLifetime)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(TService)
                && (item.ImplementationType == typeof(TImplementation)
                    || (typeof(TService) == typeof(TImplementation) && item.ImplementationType == typeof(TService))));
        Assert.Equal(expectedLifetime, descriptor.Lifetime);
    }

    private static void AssertFactoryRegistration<TService>(
        IServiceCollection services,
        ServiceLifetime expectedLifetime)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static item => item.ServiceType == typeof(TService) && item.ImplementationFactory is not null);
        Assert.Equal(expectedLifetime, descriptor.Lifetime);
    }

    [GeneratedRegex(@"\{(?<name>[^}:]+)(?::[^}]+)?\}", RegexOptions.CultureInvariant)]
    private static partial Regex RouteParameterRegex();
}
