using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotRouteIdentityBoundaryTests
{
    [Fact]
    public void TryResolve_DelegatesOnlyToRouteRegistry()
    {
        var expected = Match(PublicPageKind.Home, PublicPageId.Home, "home");
        var registry = new CapturingRouteRegistry(expected);
        var identity = new PublicAotRouteIdentity(registry);
        var context = new DefaultHttpContext();
        context.Request.Path = "/";

        bool resolved = identity.TryResolve(context, out PublicAotRouteMatch actual);

        Assert.True(resolved);
        Assert.Same(expected, actual);
        Assert.Same(context, Assert.Single(registry.Contexts));
    }

    [Fact]
    public void ResolveBackfillMatch_WhenRegistryRejectsNonPaginatedRoute_UsesCatalogIdentityFallback()
    {
        var identity = new PublicAotRouteIdentity(new RejectingRouteRegistry());
        var request = new PublicAotBackfillRequest(
            PublicPageKind.ArticleDetail,
            "42",
            "/article/42",
            string.Empty,
            "public-aot:article:42");

        PublicAotRouteMatch match = identity.ResolveBackfillMatch(request);

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(PublicPageKind.ArticleDetail);
        Assert.Equal(PublicPageKind.ArticleDetail, match.Kind);
        Assert.Equal(descriptor.PageId, match.PageId);
        Assert.Equal("42", match.RouteKey);
        Assert.Equal("/article/42", match.Path);
        Assert.Equal(
            PublicRouteIdentity.BuildCanonicalPath(descriptor.PageId, "42", null),
            match.CanonicalPath);
    }

    [Theory]
    [InlineData(PublicPageKind.Home, "home:page:2", "/", "?page=2")]
    [InlineData(PublicPageKind.Filter, "category:7", "/category/7", "?cursor=opaque")]
    public void ResolveBackfillMatch_WhenRegistryRejectsPaginatedRoute_DoesNotFallback(
        PublicPageKind kind,
        string routeKey,
        string path,
        string queryString)
    {
        var identity = new PublicAotRouteIdentity(new RejectingRouteRegistry());
        var request = new PublicAotBackfillRequest(
            kind,
            routeKey,
            path,
            queryString,
            "public-aot:stale");

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => identity.ResolveBackfillMatch(request));

        Assert.Equal("public_aot_cursor_only_route_required", error.Message);
    }

    [Fact]
    public void DependencyGraph_IsOneWayAndShellNoLongerOwnsRegistry()
    {
        ConstructorInfo identityConstructor = Assert.Single(typeof(PublicAotRouteIdentity).GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.Equal(
            [typeof(IPublicAotRouteRegistry)],
            identityConstructor.GetParameters().Select(static parameter => parameter.ParameterType));

        ConstructorInfo shellConstructor = Assert.Single(typeof(PublicAotShellService).GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Type[] shellDependencies = shellConstructor.GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IPublicAotDocumentComposition), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotRouteIdentity), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotRouteRegistry), shellDependencies);
        ConstructorInfo compositionConstructor = Assert.Single(typeof(PublicAotDocumentComposition).GetConstructors(
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic));
        Assert.Contains(
            compositionConstructor.GetParameters(),
            static parameter => parameter.ParameterType == typeof(IPublicAotRouteIdentity));
        Assert.DoesNotContain(
            identityConstructor.GetParameters(),
            static parameter => parameter.ParameterType == typeof(IPublicAotShellService)
                || parameter.ParameterType == typeof(PublicAotShellService));
        Assert.DoesNotContain(
            typeof(IPublicAotShellService).GetMethods(),
            static method => method.Name == "TryResolve");
    }

    [Fact]
    public void Composition_RegistersRouteIdentityAsSingletonPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimePublicAotServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IPublicAotRouteIdentity));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Equal(typeof(PublicAotRouteIdentity), descriptor.ImplementationType);
    }

    private static PublicAotRouteMatch Match(PublicPageKind kind, PublicPageId pageId, string routeKey)
        => new(kind, pageId, routeKey, "/", "/", string.Empty);

    private sealed class CapturingRouteRegistry(PublicAotRouteMatch match) : IPublicAotRouteRegistry
    {
        public List<HttpContext> Contexts { get; } = [];

        public bool TryResolve(HttpContext context, out PublicAotRouteMatch resolved)
        {
            Contexts.Add(context);
            resolved = match;
            return true;
        }
    }

    private sealed class RejectingRouteRegistry : IPublicAotRouteRegistry
    {
        public bool TryResolve(HttpContext context, out PublicAotRouteMatch match)
        {
            match = default!;
            return false;
        }
    }
}
