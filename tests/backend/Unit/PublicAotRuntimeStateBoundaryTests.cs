using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotRuntimeStateBoundaryTests
{
    [Fact]
    public void ContextProjection_IsOwnedByRuntimeStatePort()
    {
        var state = new PublicAotRuntimeState(
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()));
        var context = new DefaultHttpContext();
        var entry = new PublicAotCacheEntry
        {
            Source = PublicAotWriteSource.ServerSsrBackfill,
            RendererVersion = PublicAotShellService.PublicRendererVersion
        };

        state.SetAssetMode(context, "prod-manifest");
        state.SetFresh(context, entry);

        Assert.Equal("server-ssr", context.Items[PublicAotRuntimeState.PublicAotSourceContextKey]);
        Assert.Equal(
            PublicAotShellService.PublicRendererVersion,
            context.Items[PublicAotRuntimeState.PublicAotVersionContextKey]);
        Assert.Equal("none", context.Items[PublicAotRuntimeState.PublicAotBackfillContextKey]);
        Assert.Equal("fresh", context.Items[PublicAotRuntimeState.PublicAotStateContextKey]);
        Assert.Equal("prod-manifest", context.Items[PublicAotRuntimeState.PublicAotAssetModeContextKey]);
    }

    [Theory]
    [InlineData(PublicAotRenderStatus.PermanentRedirect, "server-redirect", "permanent-redirect")]
    [InlineData(PublicAotRenderStatus.NotFound, "server-status", "not-found")]
    [InlineData(PublicAotRenderStatus.TransientFailure, "server-status", "transient-failure")]
    public void ClassifiedFailure_ProjectsStableHeaderState(
        PublicAotRenderStatus status,
        string expectedSource,
        string expectedState)
    {
        var state = new PublicAotRuntimeState(
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()));
        var context = new DefaultHttpContext();

        state.SetClassifiedFailure(context, status, "prod-manifest");

        Assert.Equal(expectedSource, context.Items[PublicAotRuntimeState.PublicAotSourceContextKey]);
        Assert.Equal(expectedState, context.Items[PublicAotRuntimeState.PublicAotStateContextKey]);
        Assert.Equal("none", context.Items[PublicAotRuntimeState.PublicAotBackfillContextKey]);
    }

    [Fact]
    public void DependencyGraph_MovesRuntimeStateOutOfShellWithoutCallback()
    {
        Type[] shellDependencies = Assert.Single(typeof(PublicAotShellService).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IPublicAotRuntimeState), shellDependencies);
        Assert.DoesNotContain(typeof(PublicAotSsrRuntimeState), shellDependencies);

        ParameterInfo[] stateDependencies = Assert.Single(typeof(PublicAotRuntimeState).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.Equal([typeof(PublicAotSsrRuntimeState)], stateDependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(
            stateDependencies,
            static parameter => parameter.ParameterType == typeof(IPublicAotShellService)
                || parameter.ParameterType == typeof(PublicAotShellService));
    }

    [Fact]
    public void Composition_RegistersNarrowSingletonPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimePublicAotServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IPublicAotRuntimeState));
        Assert.Equal(ServiceLifetime.Singleton, descriptor.Lifetime);
        Assert.Equal(typeof(PublicAotRuntimeState), descriptor.ImplementationType);
    }
}
