using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Taxonomy;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

using StackExchange.Redis;
using FsusBlog.Shared.Contracts.Governance;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationSideEffectBoundaryTests
{
    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void DependencyGraph_CoordinatorOnlyOwnsOrchestrationPorts()
    {
        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(IArticlePublicMutationFence),
                typeof(ArticleMutationProjectionInvalidator),
                typeof(ArticleMutationDelivery),
                typeof(ArticleAssetCleanupPolicy),
                typeof(ILogger<ArticleMutationSideEffectCoordinator>)
            ],
            ConstructorDependencies(typeof(ArticleMutationSideEffectCoordinator)));

        Type[] dependencies = ConstructorDependencies(typeof(ArticleMutationSideEffectCoordinator));
        Assert.DoesNotContain(typeof(IConnectionMultiplexer), dependencies);
        Assert.DoesNotContain(typeof(ICacheInvalidationStore), dependencies);
        Assert.DoesNotContain(typeof(IIntegrityProofScheduler), dependencies);
        Assert.DoesNotContain(typeof(IServiceProvider), dependencies);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void DependencyGraph_NarrowOwnersHoldTheirOwnUseCasePorts()
    {
        Assert.Equal(
            [
                typeof(IPublicMutationFenceLease),
                typeof(IPublicArtifactRevocationCoordinator),
                typeof(PublicHotArtifactUpdateQueue),
                typeof(ILogger<ArticlePublicMutationFence>)
            ],
            ConstructorDependencies(typeof(ArticlePublicMutationFence)));
        Assert.Equal(
            [
                typeof(ISearchIndexService),
                typeof(IMessageRealtimePublisher),
                typeof(IIntegrityProofScheduler)
            ],
            ConstructorDependencies(typeof(ArticleMutationDelivery)));
        Assert.Contains(typeof(ITaxonomyCountProjectionService), ConstructorDependencies(typeof(ArticleMutationProjectionInvalidator)));
        Assert.Contains(typeof(IArticleDetailAedsArtifactProjector), ConstructorDependencies(typeof(ArticleMutationProjectionInvalidator)));
        Assert.Contains(typeof(IPublicArtifactRevocationCoordinator), ConstructorDependencies(typeof(ArticleMutationProjectionInvalidator)));
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void FenceMethods_AreRemovedFromSideEffectCoordinatorContract()
    {
        Assert.Null(typeof(IArticleMutationSideEffectCoordinator).GetMethod("BeginPublicMutationFenceAsync"));
        Assert.Null(typeof(IArticleMutationSideEffectCoordinator).GetMethod("CommitPublicMutationFenceAsync"));
        Assert.Null(typeof(IArticleMutationSideEffectCoordinator).GetMethod("RecoverAbortedPublicMutationFenceAsync"));
        Assert.Null(typeof(ArticleMutationSideEffectCoordinator).GetMethod("BeginPublicMutationFenceAsync"));
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void Composition_RegistersEveryMutationBoundaryAsScoped()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();

        AssertScoped<IArticlePublicMutationFence, ArticlePublicMutationFence>(services);
        AssertScoped<IArticleMutationSideEffectCoordinator, ArticleMutationSideEffectCoordinator>(services);
        AssertScopedImplementation<ArticleMutationProjectionInvalidator>(services);
        AssertScopedImplementation<ArticleMutationDelivery>(services);
        AssertScopedImplementation<ArticleAssetCleanupPolicy>(services);
    }

    private static Type[] ConstructorDependencies(Type implementation)
        => Assert.Single(implementation.GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

    private static void AssertScoped<TService, TImplementation>(IServiceCollection services)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(TService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(TImplementation), descriptor.ImplementationType);
    }

    private static void AssertScopedImplementation<TImplementation>(IServiceCollection services)
    {
        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(TImplementation));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(TImplementation), descriptor.ImplementationType);
    }
}
