using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Taxonomy;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using SqlSugar;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleMutationSideEffectBoundaryTests
{
    [Fact]
    public async Task AfterCreated_UsesInjectedBusinessTimeForPublicFenceCommit()
    {
        DateTimeOffset businessNow = new(2100, 1, 2, 3, 4, 5, TimeSpan.Zero);
        var timeProvider = new FixedTimeProvider(businessNow);
        IArticlePublicMutationFence fence = Substitute.For<IArticlePublicMutationFence>();
        IConnectionMultiplexer redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());
        var projections = new ArticleMutationProjectionInvalidator(
            RedisOperationExecutor.ForTestConnection(redis),
            Substitute.For<IRuntimeKeyScope>(),
            Substitute.For<ICacheInvalidationStore>(),
            Substitute.For<ITaxonomyCountProjectionService>(),
            Substitute.For<IArticleDetailAedsArtifactProjector>(),
            Substitute.For<IPublicArtifactRevocationCoordinator>(),
            new PublicHotArtifactUpdateQueue(
                Options.Create(new PublicHotReadOptions { UpdateQueueCapacity = 1 }),
                new InMemoryPublicHotArtifactDeliveryStateStore()),
            NullLogger<ArticleMutationProjectionInvalidator>.Instance);
        var coordinator = new ArticleMutationSideEffectCoordinator(
            Substitute.For<ISqlSugarClient>(),
            fence,
            projections,
            new ArticleMutationDelivery(
                Substitute.For<ISearchIndexService>(),
                Substitute.For<IMessageRealtimePublisher>(),
                Substitute.For<IIntegrityProofScheduler>()),
            new ArticleAssetCleanupPolicy(new ArticleAssetCleanupQueue()),
            timeProvider,
            NullLogger<ArticleMutationSideEffectCoordinator>.Instance);
        var article = new Article
        {
            Status = ArticleStatus.Published,
            PublishedAt = businessNow.UtcDateTime.AddMinutes(-1)
        };

        await coordinator.AfterCreatedAsync(article, 42, preview: null);

        await fence.Received(1).CommitPublicMutationFenceAsync(
            null,
            "article-created",
            CancellationToken.None);
    }

    [Fact]
    public void DependencyGraph_CoordinatorOnlyOwnsOrchestrationPorts()
    {
        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(IArticlePublicMutationFence),
                typeof(ArticleMutationProjectionInvalidator),
                typeof(ArticleMutationDelivery),
                typeof(ArticleAssetCleanupPolicy),
                typeof(TimeProvider),
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
    public void FenceMethods_AreRemovedFromSideEffectCoordinatorContract()
    {
        Assert.Null(typeof(IArticleMutationSideEffectCoordinator).GetMethod("BeginPublicMutationFenceAsync"));
        Assert.Null(typeof(IArticleMutationSideEffectCoordinator).GetMethod("CommitPublicMutationFenceAsync"));
        Assert.Null(typeof(IArticleMutationSideEffectCoordinator).GetMethod("RecoverAbortedPublicMutationFenceAsync"));
        Assert.Null(typeof(ArticleMutationSideEffectCoordinator).GetMethod("BeginPublicMutationFenceAsync"));
    }

    [Fact]
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

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
