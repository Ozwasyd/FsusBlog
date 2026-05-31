using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Tests ArticleService validation paths and early returns that don't require DB/Redis.
/// </summary>
public class ArticleServiceValidationTests
{
    private static ArticleService BuildService()
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(Substitute.For<IDatabase>());

        return new ArticleService(
            _db: Substitute.For<ISqlSugarClient>(),
            _searchIndex: Substitute.For<ISearchIndexService>(),
            _redisConnection: redis,
            _cache: Substitute.For<IUnifiedCache>(),
            _cacheMissCoordinator: Substitute.For<ICacheMissCoordinator>(),
            _dbConcurrencyGate: Substitute.For<IDbConcurrencyGate>(),
            _runtimeKeyScope: Substitute.For<IRuntimeKeyScope>(),
            _httpContextAccessor: Substitute.For<IHttpContextAccessor>(),
            _logger: NullLogger<ArticleService>.Instance,
            _publicAotInvalidationService: Substitute.For<IPublicAotInvalidationService>(),
            _cacheInvalidationDispatcher: Substitute.For<ICacheInvalidationDispatcher>(),
            _mutationSideEffects: Substitute.For<IArticleMutationSideEffectCoordinator>());
    }

    // ─── SearchArticlesAsync guard ────────────────────────────────────────────

    [Fact]
    public async Task SearchArticlesAsync_NullKeyword_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync(null!);
        Assert.Empty(result);
    }

    [Fact]
    public async Task SearchArticlesAsync_EmptyKeyword_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync(string.Empty);
        Assert.Empty(result);
    }

    [Fact]
    public async Task SearchArticlesAsync_WhitespaceKeyword_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync("   ");
        Assert.Empty(result);
    }

    [Fact]
    public async Task SearchArticlesAsync_TabAndNewlineOnly_ReturnsEmpty()
    {
        var svc = BuildService();
        var result = await svc.SearchArticlesAsync("\t\n\r");
        Assert.Empty(result);
    }
}
