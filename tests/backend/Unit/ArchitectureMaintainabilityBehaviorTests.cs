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
    public void SplitRuntimeServices_PreserveServiceContractsAndDependencyInjectionLifetimes()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        EndpointContractApplication.AddContractServices(builder);
        IServiceCollection services = builder.Services;

        AssertRegistration<ISearchIndexService, SearchIndexService>(services, ServiceLifetime.Singleton);
        AssertRegistration<ArticleService, ArticleService>(services, ServiceLifetime.Scoped);
        AssertRegistration<AuthoringWorkflowService, AuthoringWorkflowService>(services, ServiceLifetime.Scoped);
        AssertRegistration<ISchemaMigrationRegistry, SchemaMigrationRegistry>(services, ServiceLifetime.Singleton);
        AssertRegistration<PublicHotReadStore, PublicHotReadStore>(services, ServiceLifetime.Singleton);
        AssertRegistration<PublicHotReadCounters, PublicHotReadCounters>(services, ServiceLifetime.Singleton);

        Assert.True(typeof(ISearchIndexService).IsAssignableFrom(typeof(SearchIndexService)));
        Assert.True(typeof(IArticleService).IsAssignableFrom(typeof(ArticleService)));
    }

    [Fact]
    public void AuthoringWorkflow_PublicCapabilitySurface_RemainsStableAcrossPartialFiles()
    {
        string[] methodNames = typeof(AuthoringWorkflowService)
            .GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly)
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

    [GeneratedRegex(@"\{(?<name>[^}:]+)(?::[^}]+)?\}", RegexOptions.CultureInvariant)]
    private static partial Regex RouteParameterRegex();
}
