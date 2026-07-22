using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class ArticleEndpointServiceTests
{
    [Fact]
    public async Task GetByIdAsync_MapsPrivatePermissionAndCancellationTokenToCurrentQuery()
    {
        var core = Substitute.For<IArticleCoreService>();
        using var cts = new CancellationTokenSource();
        core.GetByIdAsync(new ArticleDetailQuery(42, IncludePrivate: true), cts.Token)
            .Returns(Result<ArticleDetailCoreModel?>.Failure(ErrorCode.NotFound, "missing"));
        var service = Create(core);

        Result<ArticleDetailCoreModel?> result = await service.GetByIdAsync(
            42,
            canReadPrivate: true,
            cancellationToken: cts.Token);

        Assert.False(result.IsSuccess);
        await core.Received(1).GetByIdAsync(
            Arg.Is<ArticleDetailQuery>(query => query.Id == 42 && query.IncludePrivate),
            cts.Token);
    }

    [Fact]
    public async Task GetPageListAsync_RejectsDeletedAndStatusFiltersWithoutRequiredPermission()
    {
        var core = Substitute.For<IArticleCoreService>();
        var cache = Substitute.For<IUnifiedCache>();
        var ownedFrameCache = CreateOwnedFrameCacheSubstitute();
        var service = Create(core, cache: cache, ownedFrameCache: ownedFrameCache);

        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> deleted = await service.GetPageListAsync(
            1, 10, null, null, isDeleted: true, canReadDeleted: false, status: null, canReadPrivate: false);
        ArticleEndpointPayload<CorePageResult<ArticleListCoreModel>> privateStatus = await service.GetPageListAsync(
            1, 10, null, null, isDeleted: false, canReadDeleted: false,
            status: ArticleStatusValues.Draft, canReadPrivate: false);

        Assert.Equal(ErrorCode.Forbidden, deleted.Result.Error.Code);
        Assert.Equal(ErrorCode.Forbidden, privateStatus.Result.Error.Code);
        await cache.DidNotReceiveWithAnyArgs().GetStringAsync(default, default!, default);
        await ownedFrameCache.DidNotReceiveWithAnyArgs().TryGetOwnedFrameAsync(default, (string)null!, default, default);
        await core.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }
}
