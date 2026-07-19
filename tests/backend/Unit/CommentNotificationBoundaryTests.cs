using System.Reflection;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentNotificationBoundaryTests
{
    [Fact]
    public async Task PublishRemoved_UsesOnlyRealtimePort()
    {
        var realtime = Substitute.For<IMessageRealtimePublisher>();
        var commands = Substitute.For<IMessageCommandService>();
        var notifications = new CommentNotificationService(
            realtime,
            commands,
            Substitute.For<ILogger<CommentNotificationService>>());

        await notifications.PublishRemovedAsync(42, 100, 90, 80);

        await realtime.Received(1).PushCommentRemoveAsync(42, 100, 90, 80);
    }

    [Fact]
    public void DependencyGraph_MovesMessagePortsOutOfCommentServiceWithoutCallback()
    {
        Type[] commandDependencies = Assert.Single(typeof(CommentService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(ICommentNotificationService), commandDependencies);
        Assert.DoesNotContain(typeof(IMessageRealtimePublisher), commandDependencies);
        Assert.DoesNotContain(typeof(IMessageCommandService), commandDependencies);

        ParameterInfo[] notificationDependencies = Assert.Single(typeof(CommentNotificationService).GetConstructors())
            .GetParameters();
        Assert.Equal(
            [
                typeof(IMessageRealtimePublisher),
                typeof(IMessageCommandService),
                typeof(ILogger<CommentNotificationService>)
            ],
            notificationDependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(
            notificationDependencies,
            static parameter => parameter.ParameterType == typeof(CommentService));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(ICommentNotificationService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(CommentNotificationService), descriptor.ImplementationType);
    }
}
