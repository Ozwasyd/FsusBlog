using System.Reflection;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentModerationBoundaryTests
{
    [Fact]
    public void DependencyGraph_MovesPolicyAndVisibilityPortsOutOfCommentCommand()
    {
        Type[] commandDependencies = Assert.Single(typeof(CommentCommandService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(ICommentModerationService), commandDependencies);
        Assert.DoesNotContain(typeof(IRegionLegalModerationService), commandDependencies);
        Assert.DoesNotContain(typeof(IAntiSpamModerationService), commandDependencies);
        Assert.DoesNotContain(typeof(ICommentModerationDispositionPolicy), commandDependencies);
        Assert.DoesNotContain(typeof(AuditLogChannel), commandDependencies);

        ParameterInfo[] moderationDependencies = Assert.Single(typeof(CommentModerationService).GetConstructors())
            .GetParameters();
        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(IRegionLegalModerationService),
                typeof(ICacheInvalidationDispatcher),
                typeof(ICommentNotificationService),
                typeof(ILogger<CommentModerationService>),
                typeof(IAntiSpamModerationService),
                typeof(ICommentModerationDispositionPolicy),
                typeof(AuditLogChannel),
                typeof(IAnonymousCommentPolicyService),
                typeof(IConfiguration),
                typeof(ICommentMutationOutbox)
            ],
            moderationDependencies.Select(static parameter => parameter.ParameterType));
        Assert.DoesNotContain(
            moderationDependencies,
            static parameter => parameter.ParameterType == typeof(CommentCommandService));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(ICommentModerationService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(CommentModerationService), descriptor.ImplementationType);
    }

    [Fact]
    public void RuntimeBoundary_ExposesOnlyDecisionPersistenceAndPostInsertUseCases()
    {
        string[] methods = typeof(ICommentModerationService)
            .GetMethods(BindingFlags.Instance | BindingFlags.Public)
            .Select(static method => method.Name)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            ["ApplyPostInsertAsync", "PersistVisibilityAsync", "ResolveInitialState", "ResolveSubmissionRegion"],
            methods);
    }
}
