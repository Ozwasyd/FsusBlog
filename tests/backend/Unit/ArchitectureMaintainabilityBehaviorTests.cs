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
        string composition = RuntimeMetadataInspection.DescribeType(typeof(WebApplicationCompositionExtensions));

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

        const BindingFlags RuntimeMethods = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        Assert.NotNull(typeof(PublicWebRuntime).GetMethod("ServePublicShellOrIndexAsync", RuntimeMethods));
        Assert.NotNull(typeof(PublicWebRuntime).GetMethod("WritePublicStatusHtmlAsync", RuntimeMethods));
        Assert.NotNull(typeof(PublicWebRuntime).GetMethod("WriteSpaHtmlResponseAsync", RuntimeMethods));
    }

    [Fact]
    public void RuntimeServiceRegistrationRoots_DoNotExecuteUseCasesOrMaterializeResponses()
    {
        string infrastructure = RuntimeMetadataInspection.DescribeType(
            typeof(RuntimeInfrastructureServiceCollectionExtensions));
        string domain = RuntimeMetadataInspection.DescribeType(typeof(RuntimeDomainServiceCollectionExtensions));
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
            "ListCommentModerationQueuePageAsync",
            "ModerateCommentAsync",
            "ModerateCommentsAsync",
            "PreviewAsync",
            "ReindexAssetsAsync",
            "RollbackRevisionAsync",
            "RunPrepublishCheck",
            "RunPrepublishCheckAsync",
            "SaveDraftAsync"
        ], methodNames);

        Assembly serverAssembly = typeof(ArticleService).Assembly;
        Assert.DoesNotContain(
            serverAssembly.GetTypes(),
            static type => string.Equals(type.Name, "AuthoringWorkflowService", StringComparison.Ordinal));

        string endpoints = RuntimeMetadataInspection.DescribeType(typeof(AuthoringEndpoints));
        Assert.DoesNotContain(nameof(AuthoringAnalyticsReadService), endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(AuthoringAssetLibraryService), endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(AuthoringDraftLifecycleService), endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(AuthoringContentTransferService), endpoints, StringComparison.Ordinal);
        Assert.DoesNotContain(nameof(AuthoringModerationWorkflowService), endpoints, StringComparison.Ordinal);

        Type[] authoringRuntimeTypes = serverAssembly.GetTypes()
            .Where(static type => string.Equals(
                type.Namespace,
                typeof(AuthoringAnalyticsReadService).Namespace,
                StringComparison.Ordinal))
            .ToArray();
        Assert.DoesNotContain(
            authoringRuntimeTypes,
            static type => RuntimeMetadataInspection.DescribeType(type)
                .Contains(nameof(IServiceProvider), StringComparison.Ordinal));

        var implementations = new Dictionary<string, Type>(StringComparer.Ordinal)
        {
            [nameof(AuthoringAnalyticsReadService)] = typeof(AuthoringAnalyticsReadService),
            [nameof(AuthoringAssetLibraryService)] = typeof(AuthoringAssetLibraryService),
            [nameof(AuthoringDraftLifecycleService)] = typeof(AuthoringDraftLifecycleService),
            [nameof(AuthoringContentTransferService)] = typeof(AuthoringContentTransferService),
            [nameof(AuthoringModerationWorkflowService)] = typeof(AuthoringModerationWorkflowService)
        };
        foreach ((string owner, Type implementation) in implementations)
        {
            string runtimeShape = RuntimeMetadataInspection.DescribeType(implementation);
            Assert.DoesNotContain(
                implementations.Keys.Where(candidate => !string.Equals(candidate, owner, StringComparison.Ordinal)),
                runtimeShape.Contains);
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

        Assert.Equal(80, endpoints.Length);
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
