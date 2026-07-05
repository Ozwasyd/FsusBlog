using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests;

public sealed class PublicAotRouteManifestTests
{
    [Fact]
    public void DescriptorFactories_ProduceRegistryResolvableRoutes()
    {
        PublicAotRouteDescriptor[] descriptors =
        [
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Home, 0),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.About, 10),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Privacy, 11),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Guidelines, 12),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Copyright, 13),
            PublicAotRouteManifestProvider.CreateStaticRoute(PublicPageKind.Archive, 20),
            PublicAotRouteManifestProvider.CreateArticleRoute(42, 7, [3, 9], 100),
            PublicAotRouteManifestProvider.CreateCategoryRoute(7, 200),
            PublicAotRouteManifestProvider.CreateTagIdRoute(3, "CSharp", 210),
            PublicAotRouteManifestProvider.CreateTagNameRoute(3, "CSharp", 220)
        ];
        var registry = new PublicAotRouteRegistry();

        foreach (PublicAotRouteDescriptor descriptor in descriptors)
        {
            var context = new DefaultHttpContext();
            context.Request.Path = descriptor.Path;

            Assert.True(registry.TryResolve(context, out PublicAotRouteMatch match));
            Assert.Equal(descriptor.PageId, match.PageId);
            Assert.Equal(descriptor.Kind, match.Kind);
            Assert.Equal(descriptor.RouteKey, match.RouteKey);
            Assert.Equal(descriptor.CanonicalPath, match.CanonicalPath);
            Assert.Contains("seo", descriptor.DependencyKeys);
        }
    }

    [Fact]
    public void ScopeParser_SupportsAllHotAndChangedSince()
    {
        Assert.Equal("all", PublicAotRouteManifestScope.FromQuery(null, null).Scope);

        PublicAotRouteManifestScope hot = PublicAotRouteManifestScope.FromQuery("hot", null);
        Assert.True(hot.IsHot);
        Assert.Equal(64, hot.Limit);

        PublicAotRouteManifestScope changed = PublicAotRouteManifestScope.FromQuery("all", "2026-06-01T00:00:00Z");
        Assert.True(changed.IsChanged);
        Assert.Equal("changed", changed.Scope);
    }

    [Fact]
    public void Source_ExposesInternalEndpointAndPublicVisibilityFilters()
    {
        string endpointSource = ReadRepoFile("src/backend/Modules/Endpoints/PublicAotEndpoints.cs");
        string providerSource = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotRouteManifest.cs");
        string invalidationSource = ReadRepoFile("src/backend/Infrastructure/PublicAot/PublicAotInvalidationService.cs");
        string diagnosticSource = ReadRepoFile("tools/operations/public-aot-health.mjs");

        Assert.Contains("/internal/public-aot", endpointSource);
        Assert.Contains("/manifest", endpointSource);
        Assert.Contains("/health", endpointSource);
        Assert.Contains("X-Fsus-Public-Aot-Token", endpointSource);
        Assert.Contains("PublicAotSsrHealthService", endpointSource);
        Assert.Contains("ArticleStatus.Published", providerSource);
        Assert.Contains("PublishedAt", providerSource);
        Assert.Contains("ScheduledPublishAt", providerSource);
        Assert.Contains("article.PublishedAt == null || article.PublishedAt <= utcNow", providerSource);
        Assert.Contains("article.ScheduledPublishAt == null || article.ScheduledPublishAt <= utcNow", providerSource);
        Assert.DoesNotContain("article.PublishedAt.HasValue", providerSource);
        Assert.DoesNotContain("article.ScheduledPublishAt.HasValue", providerSource);
        Assert.Contains("CreateArticleRoute", invalidationSource);
        Assert.Contains("public_aot_manifest_pregenerate", invalidationSource);
        Assert.Contains("/internal/public-aot/health", diagnosticSource);
        Assert.Contains("X-Fsus-Public-Aot-Token", diagnosticSource);
    }

    [Fact]
    public void Source_ManifestAndHealthFailClosedInProductionWhenTokenIsMissing()
    {
        string endpointSource = ReadRepoFile("src/backend/Modules/Endpoints/PublicAotEndpoints.cs");
        string validatorSource = ReadRepoFile("src/backend/Infrastructure/Operations/ProductionStartupValidator.cs");
        string designDoc = ReadRepoFile("docs/api/design.md");
        string contractsDoc = ReadRepoFile("docs/api/contracts.md");

        Assert.Contains("IWebHostEnvironment environment", endpointSource);
        Assert.Contains("IsManifestRequestAuthorized(context, configuration, environment)", endpointSource);
        Assert.Contains("environment.IsProduction()", endpointSource);
        Assert.DoesNotContain("if (string.IsNullOrWhiteSpace(requiredToken))\n        {\n            return true;", endpointSource, StringComparison.Ordinal);
        Assert.Contains("Value(\"PublicAot:ManifestToken\")", validatorSource);
        Assert.Contains("PublicAot:ManifestToken", designDoc);
        Assert.Contains("生产", designDoc);
        Assert.Contains("PublicAot:ManifestToken", contractsDoc);
        Assert.Contains("生产", contractsDoc);
    }

    private static string ReadRepoFile(string relativePath)
    {
        string fullPath = BackendTestPaths.FromRoot(relativePath);
        Assert.True(File.Exists(fullPath), $"{relativePath} must exist.");
        return File.ReadAllText(fullPath);
    }
}
