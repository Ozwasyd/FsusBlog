using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.CoreBridge.Gateways;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentQueryBoundaryTests
{
    [Fact]
    public void DependencyGraph_UsesOnlyQueryPortsWithoutAggregateCallback()
    {
        Type[] dependencies = Assert.Single(typeof(CommentQueryService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Equal([typeof(ISqlSugarClient), typeof(IRegionLegalModerationService)], dependencies);

        string[] aggregateMethods = typeof(CommentService).GetMethods()
            .Select(static method => method.Name)
            .ToArray();
        Assert.DoesNotContain("GetCommentThreadsByCursorAsync", aggregateMethods);
        Assert.DoesNotContain("GetThreadRepliesByCursorAsync", aggregateMethods);
        Assert.DoesNotContain("GetCommentsByCursorAsync", aggregateMethods);
        Assert.DoesNotContain("GetAttributableCommentsAsync", aggregateMethods);

        Type[] gatewayDependencies = Assert.Single(typeof(CommentCoreGateway).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(ICommentQueryService), gatewayDependencies);
        Assert.Contains(typeof(ICommentCommandService), gatewayDependencies);
        Assert.DoesNotContain(typeof(CommentService), gatewayDependencies);
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(ICommentQueryService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(CommentQueryService), descriptor.ImplementationType);
    }
}
