using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;
using System.Runtime.CompilerServices;

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
        string repoRoot = FindRepoRoot();
        string endpointSource = File.ReadAllText(Path.Combine(repoRoot, "src/backend/Modules/Endpoints/PublicAotEndpoints.cs"));
        string providerSource = File.ReadAllText(Path.Combine(repoRoot, "src/backend/Infrastructure/PublicAot/PublicAotRouteManifest.cs"));
        string invalidationSource = File.ReadAllText(Path.Combine(repoRoot, "src/backend/Infrastructure/PublicAot/PublicAotInvalidationService.cs"));
        string diagnosticSource = File.ReadAllText(Path.Combine(repoRoot, "tools", "operations", "public-aot-health.mjs"));

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

    private static string FindRepoRoot([CallerFilePath] string sourceFile = "")
    {
        string current = Path.GetDirectoryName(sourceFile) ?? AppContext.BaseDirectory;
        while (!string.IsNullOrWhiteSpace(current))
        {
            if (File.Exists(Path.Combine(current, "FsusBlog.slnx")) ||
                File.Exists(Path.Combine(current, "src", "backend", "Infrastructure", "PublicAot", "PublicAotRouteManifest.cs")))
            {
                return current;
            }

            DirectoryInfo? parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        throw new DirectoryNotFoundException("Unable to locate repository root.");
    }
}
