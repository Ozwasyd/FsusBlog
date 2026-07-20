using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentCommandBoundaryTests
{
    [Fact]
    public void DependencyGraph_CommandDependsOnlyOnDatabaseLoggerAndNarrowPorts()
    {
        Type[] dependencies = Assert.Single(typeof(CommentCommandService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(ILogger<CommentCommandService>),
                typeof(ICommentNotificationService),
                typeof(ICommentModerationService),
                typeof(ICommentAttributionPrivacyService),
                typeof(ICacheInvalidationDispatcher),
                typeof(IConfiguration),
                typeof(ICommentMutationOutbox)
            ],
            dependencies);
        Assert.DoesNotContain(typeof(ICommentQueryService), dependencies);
    }

    [Fact]
    public void Composition_MapsBothCommandContractsToOneScopedImplementation()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor implementation = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(CommentCommandService));
        Assert.Equal(ServiceLifetime.Scoped, implementation.Lifetime);
        Assert.Single(services, static descriptor => descriptor.ServiceType == typeof(ICommentEndpointService));
        Assert.Single(services, static descriptor => descriptor.ServiceType == typeof(ICommentCommandService));
        Assert.Single(services, static descriptor => descriptor.ServiceType == typeof(ICommentMutationOutbox));
    }

    [Fact]
    public void RuntimeShape_HasNoGenericCommentServiceType()
    {
        Type? legacy = typeof(CommentCommandService).Assembly.GetType("FsusBlog.Server.Services.CommentService");

        Assert.Null(legacy);
        Assert.True(typeof(ICommentEndpointService).IsAssignableFrom(typeof(CommentCommandService)));
        Assert.True(typeof(ICommentCommandService).IsAssignableFrom(typeof(CommentCommandService)));
    }
}
