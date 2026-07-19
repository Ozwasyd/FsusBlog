using System.Reflection;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.Spa;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotArtifactStoreBoundaryTests
{
    [Fact]
    public void LookupAndBackfill_UseVersionedRuntimeScopedKeysThroughArtifactPort()
    {
        var cache = Substitute.For<IPublicAotShellCache>();
        var writer = Substitute.For<IPublicAotCacheWriter>();
        var scheduler = Substitute.For<IPublicAotBackfillScheduler>();
        PublicAotBackfillRequest? scheduled = null;
        scheduler.TrySchedule(Arg.Do<PublicAotBackfillRequest>(request => scheduled = request)).Returns(true);
        var manifest = Substitute.For<ISpaAssetManifestService>();
        manifest.GetFrontendAssetVersion(Arg.Any<HttpContext>()).Returns("frontend-v1");
        var tracker = new PublicAotInvalidationTracker();
        var store = new PublicAotArtifactStore(
            cache,
            writer,
            scheduler,
            manifest,
            new PrefixRuntimeKeyScope("test-session:"),
            tracker);
        var context = new DefaultHttpContext();
        var match = new PublicAotRouteMatch(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty);

        PublicAotArtifactLookup lookup = store.CreateLookup(context, match);
        bool queued = store.TryScheduleBackfill(context, match, lookup);

        string baseKey = string.Concat(
            "test-session:",
            CacheKeyBuilder.PublicAotDocument(PublicPageId.Home, "home"));
        Assert.Equal(string.Concat(baseKey, ":lv:0"), lookup.DocumentCacheKey);
        Assert.Equal("frontend-v1", lookup.FrontendAssetVersion);
        Assert.Equal("prod-manifest", lookup.AssetMode);
        Assert.True(queued);
        Assert.NotNull(scheduled);
        Assert.Equal(lookup.DocumentCacheKey, scheduled.CacheKey);
        Assert.Equal(lookup.PagePrefixKey, scheduled.PagePrefixKey);
        Assert.Equal(0, scheduled.ScheduledInvalidationVersion);
    }

    [Fact]
    public void DependencyGraph_MovesStoragePortsOutOfShellWithoutCallback()
    {
        Type[] shellDependencies = Assert.Single(typeof(PublicAotShellService).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IPublicAotArtifactStore), shellDependencies);
        Assert.Contains(typeof(IPublicAotRuntimeState), shellDependencies);
        Assert.DoesNotContain(typeof(PublicAotSsrRuntimeState), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotShellCache), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotCacheWriter), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotBackfillScheduler), shellDependencies);
        Assert.DoesNotContain(typeof(ISpaAssetManifestService), shellDependencies);
        Assert.DoesNotContain(typeof(IRuntimeKeyScope), shellDependencies);
        Assert.DoesNotContain(typeof(PublicAotInvalidationTracker), shellDependencies);

        ParameterInfo[] artifactDependencies = Assert.Single(typeof(PublicAotArtifactStore).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.DoesNotContain(
            artifactDependencies,
            static parameter => parameter.ParameterType == typeof(IPublicAotShellService)
                || parameter.ParameterType == typeof(PublicAotShellService));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimePublicAotServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IPublicAotArtifactStore));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(PublicAotArtifactStore), descriptor.ImplementationType);
    }

    private sealed class PrefixRuntimeKeyScope(string prefix) : IRuntimeKeyScope
    {
        public string PrefixKey(string key) => string.Concat(prefix, key);
    }
}
