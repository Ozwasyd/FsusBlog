using NSubstitute;

using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Core.Services.Implementations;
using FsusBlog.Server.Infrastructure.CoreBridge.Adapters;
using FsusBlog.Shared.Contracts.Outputs;
namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// ArticleCoreService
// ──────────────────────────────────────────────────────────────────────────────

public class ArticleCoreServiceTests
{
    private readonly IArticleCoreGateway _gw = Substitute.For<IArticleCoreGateway>();
    private ArticleCoreService Svc() => new(_gw);

    // GetPageListAsync
    [Theory]
    [InlineData(0, 10)]
    [InlineData(-1, 10)]
    [InlineData(1, 0)]
    [InlineData(1, -5)]
    [InlineData(1, 999999)]
    public async Task GetPageList_InvalidPagination_ReturnsValidationFailure(int page, int size)
    {
        var result = await Svc().GetPageListAsync(page, size, null, null, false);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetPageList_ValidParams_CallsGateway()
    {
        var emptyPage = new CorePageResult<ArticleListCoreModel>([], 0);
        _gw.GetPageListAsync(1, 10, null, null, false).Returns(emptyPage);

        var result = await Svc().GetPageListAsync(1, 10, null, null, false);

        Assert.True(result.IsSuccess);
        Assert.Equal(0, result.Value!.Total);
    }

    [Fact]
    public async Task GetPageList_WithCategoryFilter_PassesThrough()
    {
        var page = new CorePageResult<ArticleListCoreModel>([], 5);
        _gw.GetPageListAsync(2, 20, 3, null, false).Returns(page);

        var result = await Svc().GetPageListAsync(2, 20, 3, null, false);

        Assert.True(result.IsSuccess);
        Assert.Equal(5, result.Value!.Total);
    }

    // GetByIdAsync
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task GetById_InvalidId_ReturnsValidationFailure(int id)
    {
        var result = await Svc().GetByIdAsync(id);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetById_NotFound_ReturnsNotFound()
    {
        _gw.GetByIdAsync(99).Returns((ArticleDetailCoreModel?)null);
        var result = await Svc().GetByIdAsync(99);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
    }

    [Fact]
    public async Task GetById_Found_ReturnsSuccess()
    {
        var detail = new ArticleDetailCoreModel
        {
            Id = 1,
            Title = "T",
            Content = "C",
            Summary = null,
            Views = 0,
            WordCount = 1,
            EstimatedReadingMinutes = 1,
            ShowReadingNotice = false,
            CreateTime = DateTime.UtcNow,
            Category = new(1, "Cat"),
            Tags = [],
            CategoryId = 1,
            IsDeleted = false,
            Pod = default
        };
        _gw.GetByIdAsync(1).Returns(detail);
        var result = await Svc().GetByIdAsync(1);
        Assert.True(result.IsSuccess);
        Assert.Equal(1, result.Value?.Id);
    }

    // CreateAsync
    [Theory]
    [InlineData("", "content", 1)]
    [InlineData("title", "", 1)]
    [InlineData("title", "content", 0)]
    [InlineData("  ", "content", 1)]
    public async Task Create_InvalidParams_ReturnsValidationFailure(string title, string content, int categoryId)
    {
        var result = await Svc().CreateAsync(title, content, null, null, categoryId, []);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task Create_GatewayReturnsZero_ReturnsInfraFailure()
    {
        _gw.CreateAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string?>(), Arg.Any<int>(), Arg.Any<IReadOnlyList<int>>())
           .Returns(0);
        var result = await Svc().CreateAsync("title", "content", null, null, 1, []);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, result.Error.Code);
    }

    [Fact]
    public async Task Create_GatewayReturnsId_ReturnsSuccess()
    {
        _gw.CreateAsync(Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string?>(), Arg.Any<int>(), Arg.Any<IReadOnlyList<int>>())
           .Returns(42);
        var result = await Svc().CreateAsync("title", "content", null, null, 1, []);
        Assert.True(result.IsSuccess);
        Assert.Equal(42, result.Value);
    }

    // UpdateAsync
    [Theory]
    [InlineData(0, "t", "c", 1)]
    [InlineData(1, "", "c", 1)]
    [InlineData(1, "t", "", 1)]
    [InlineData(1, "t", "c", 0)]
    public async Task Update_InvalidParams_ReturnsValidationFailure(int id, string title, string content, int categoryId)
    {
        var result = await Svc().UpdateAsync(id, title, content, null, null, categoryId, []);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task Update_NotFound_ReturnsNotFound()
    {
        _gw.UpdateAsync(Arg.Any<int>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string?>(), Arg.Any<int>(), Arg.Any<IReadOnlyList<int>>())
           .Returns(false);
        var result = await Svc().UpdateAsync(1, "t", "c", null, null, 1, []);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
    }

    [Fact]
    public async Task Update_Success()
    {
        _gw.UpdateAsync(Arg.Any<int>(), Arg.Any<string>(), Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<string?>(), Arg.Any<int>(), Arg.Any<IReadOnlyList<int>>())
           .Returns(true);
        var result = await Svc().UpdateAsync(1, "t", "c", null, null, 1, []);
        Assert.True(result.IsSuccess);
    }

    // DeleteAsync
    [Fact]
    public async Task Delete_InvalidId_ReturnsValidationFailure()
    {
        var result = await Svc().DeleteAsync(0);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task Delete_NotFound()
    {
        _gw.DeleteAsync(1).Returns(false);
        var result = await Svc().DeleteAsync(1);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.NotFound, result.Error.Code);
    }

    [Fact]
    public async Task Delete_Success()
    {
        _gw.DeleteAsync(1).Returns(true);
        Assert.True((await Svc().DeleteAsync(1)).IsSuccess);
    }

    // RestoreAsync
    [Fact]
    public async Task Restore_InvalidId_ReturnsValidationFailure()
    {
        Assert.False((await Svc().RestoreAsync(0)).IsSuccess);
    }

    [Fact]
    public async Task Restore_NotFound()
    {
        _gw.RestoreAsync(1).Returns(false);
        Assert.Equal(ErrorCode.NotFound, (await Svc().RestoreAsync(1)).Error.Code);
    }

    [Fact]
    public async Task Restore_Success()
    {
        _gw.RestoreAsync(1).Returns(true);
        Assert.True((await Svc().RestoreAsync(1)).IsSuccess);
    }

    // PermanentlyDeleteAsync
    [Fact]
    public async Task PermanentlyDelete_InvalidId()
    {
        Assert.Equal(ErrorCode.Validation, (await Svc().PermanentlyDeleteArticleAsync(0)).Error.Code);
    }

    [Fact]
    public async Task PermanentlyDelete_Success()
    {
        _gw.PermanentlyDeleteArticleAsync(1).Returns(true);
        Assert.True((await Svc().PermanentlyDeleteArticleAsync(1)).IsSuccess);
    }

    // ClearTrashAsync
    [Fact]
    public async Task ClearTrash_ReturnsCount()
    {
        _gw.ClearTrashAsync().Returns(7);
        var result = await Svc().ClearTrashAsync();
        Assert.True(result.IsSuccess);
        Assert.Equal(7, result.Value);
    }

    // SearchArticlesAsync
    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData(null)]
    public async Task Search_EmptyKeyword_ReturnsValidationFailure(string? keyword)
    {
        var result = await Svc().SearchArticlesAsync(keyword!);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task Search_ValidKeyword_ReturnsData()
    {
        IReadOnlyList<ArticleListCoreModel> list = [];
        _gw.SearchArticlesAsync("foo").Returns(list);
        var result = await Svc().SearchArticlesAsync("foo");
        Assert.True(result.IsSuccess);
    }

    // GetHotArticlesAsync
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task GetHot_InvalidCount_ReturnsValidationFailure(int count)
    {
        Assert.Equal(ErrorCode.Validation, (await Svc().GetHotArticlesAsync(count)).Error.Code);
    }

    [Fact]
    public async Task GetHot_ValidCount_ReturnsData()
    {
        IReadOnlyList<PopularArticleCoreModel> list = [];
        _gw.GetHotArticlesAsync(5).Returns(list);
        var result = await Svc().GetHotArticlesAsync(5);
        Assert.True(result.IsSuccess);
    }

    // GetFeaturedArticlesAsync
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    public async Task GetFeatured_InvalidCount_ReturnsValidationFailure(int count)
    {
        Assert.Equal(ErrorCode.Validation, (await Svc().GetFeaturedArticlesAsync(count)).Error.Code);
    }

    [Fact]
    public async Task GetFeatured_ValidCount_DelegatesToGateway()
    {
        var created = new DateTime(2025, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        IReadOnlyList<FeaturedArticleCoreModel> list =
        [
            new(1, "Article", "/cover.webp", 100, created, new ArticleCategoryCoreModel(1, "Tech"))
        ];
        _gw.GetFeaturedArticlesAsync(3).Returns(list);

        var result = await Svc().GetFeaturedArticlesAsync(3);

        Assert.True(result.IsSuccess);
        Assert.Single(result.Value!);
        Assert.Equal(1, result.Value![0].Id);
    }

    // IncreaseViewCountAsync
    [Fact]
    public async Task IncreaseViewCount_InvalidId_ReturnsValidationFailure()
    {
        Assert.Equal(ErrorCode.Validation, (await Svc().IncreaseViewCountAsync(0)).Error.Code);
    }

    [Fact]
    public async Task IncreaseViewCount_ValidId_Success()
    {
        _gw.IncreaseViewCountAsync(1).Returns(default(ValueTask));
        Assert.True((await Svc().IncreaseViewCountAsync(1)).IsSuccess);
    }

    [Fact]
    public async Task IncreaseViewCounts_ValidBatch_CallsGatewayBatch()
    {
        IReadOnlySet<int> updated = new HashSet<int> { 1, 2 };
        _gw.IncreaseViewCountsAsync(Arg.Any<IReadOnlyDictionary<int, int>>(), Arg.Any<CancellationToken>())
            .Returns(updated);

        var result = await Svc().IncreaseViewCountsAsync(new Dictionary<int, int>
        {
            [1] = 3,
            [2] = 4
        });

        Assert.True(result.IsSuccess);
        Assert.Equal(updated, result.Value);
        await _gw.Received(1).IncreaseViewCountsAsync(
            Arg.Is<IReadOnlyDictionary<int, int>>(items => items[1] == 3 && items[2] == 4),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ArticleServiceCoreAdapter_CountFlush_UsesBatchInsteadOfSingleLoop()
    {
        var core = Substitute.For<IArticleCoreService>();
        core.IncreaseViewCountsAsync(Arg.Any<IReadOnlyDictionary<int, int>>(), Arg.Any<CancellationToken>())
            .Returns(Result<IReadOnlySet<int>>.Success(new HashSet<int> { 42 }));
        var adapter = new ArticleServiceCoreAdapter(core);

        await adapter.IncreaseViewCountAsync(42, 100);

        await core.Received(1).IncreaseViewCountsAsync(
            Arg.Is<IReadOnlyDictionary<int, int>>(items => items.Count == 1 && items[42] == 100),
            Arg.Any<CancellationToken>());
        await core.DidNotReceive().IncreaseViewCountAsync(42);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// CommentCoreService
// ──────────────────────────────────────────────────────────────────────────────

public class CommentCoreServiceTests
{
    private readonly ICommentCoreGateway _gw = Substitute.For<ICommentCoreGateway>();
    private CommentCoreService Svc() => new(_gw);

    [Theory]
    [InlineData(0, 1, "content")]
    [InlineData(1, 0, "content")]
    [InlineData(1, 1, "")]
    [InlineData(1, 1, "   ")]
    public async Task CreateComment_InvalidParams_ReturnsValidationFailure(int userId, int articleId, string content)
    {
        var result = await Svc().CreateCommentAsync(userId, articleId, content);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task CreateComment_GatewayFails_ReturnsInfraFailure()
    {
        _gw.CreateCommentAsync(1, 1, "hi").Returns(false);
        var result = await Svc().CreateCommentAsync(1, 1, "hi");
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, result.Error.Code);
    }

    [Fact]
    public async Task CreateComment_Success()
    {
        _gw.CreateCommentAsync(1, 1, "hi").Returns(true);
        Assert.True((await Svc().CreateCommentAsync(1, 1, "hi")).IsSuccess);
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(1, 0)]
    public async Task GetCommentsByCursor_InvalidParams_ReturnsValidationFailure(int articleId, int limit)
    {
        var result = await Svc().GetCommentsByCursorAsync(articleId, null, limit);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetCommentsByCursor_ValidParams_ReturnsData()
    {
        var empty = new CoreCursorResult<CommentQueryCoreModel>([], null, false);
        _gw.GetCommentsByCursorAsync(1, null, 10).Returns(empty);
        var result = await Svc().GetCommentsByCursorAsync(1, null, 10);
        Assert.True(result.IsSuccess);
    }

    [Theory]
    [InlineData(0, 10)]
    [InlineData(1, 0)]
    public async Task GetUserComments_InvalidParams_ReturnsValidationFailure(int userId, int limit)
    {
        var result = await Svc().GetUserCommentsAsync(userId, null, limit);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetUserComments_ValidParams_ReturnsData()
    {
        var empty = new CoreCursorResult<UserCommentCoreModel>([], null, false);
        _gw.GetUserCommentsAsync(1, null, 5).Returns(empty);
        var result = await Svc().GetUserCommentsAsync(1, null, 5);
        Assert.True(result.IsSuccess);
    }

    [Theory]
    [InlineData(0L, 1)]
    [InlineData(1L, 0)]
    public async Task DeleteComment_InvalidParams_ReturnsValidationFailure(long id, int currentUserId)
    {
        var result = await Svc().DeleteCommentAsync(id, currentUserId, false, "r");
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task DeleteComment_NotFound()
    {
        _gw.DeleteCommentAsync(1L, 1, false, "r").Returns(false);
        Assert.Equal(ErrorCode.NotFound, (await Svc().DeleteCommentAsync(1L, 1, false, "r")).Error.Code);
    }

    [Fact]
    public async Task DeleteComment_Success()
    {
        _gw.DeleteCommentAsync(1L, 1, true, "admin").Returns(true);
        Assert.True((await Svc().DeleteCommentAsync(1L, 1, true, "admin")).IsSuccess);
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// SystemCoreService
// ──────────────────────────────────────────────────────────────────────────────

public class SystemCoreServiceTests
{
    private readonly ISystemCoreGateway _gw = Substitute.For<ISystemCoreGateway>();
    private SystemCoreService Svc() => new(_gw);

    [Fact]
    public async Task GetSeoConfig_ReturnsSuccess()
    {
        var config = new FsusBlog.Shared.Contracts.AuthSystem.SeoConfigContract();
        _gw.GetSeoConfigAsync().Returns(config);
        var result = await Svc().GetSeoConfigAsync();
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task UpdateSeoConfig_ReturnsSuccess()
    {
        var config = new FsusBlog.Shared.Contracts.AuthSystem.SeoConfigContract();
        _gw.UpdateSeoConfigAsync(config).Returns(Task.CompletedTask);
        var result = await Svc().UpdateSeoConfigAsync(config);
        Assert.True(result.IsSuccess);
    }

    [Theory]
    [InlineData("")]
    [InlineData("  ")]
    [InlineData(null)]
    public async Task GetPageContent_EmptySlug_ReturnsValidationFailure(string? slug)
    {
        var result = await Svc().GetPageContentAsync(slug!);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetPageContent_ValidSlug_ReturnsData()
    {
        var content = new FsusBlog.Shared.Contracts.AuthSystem.PageContentContract();
        _gw.GetPageContentAsync("about").Returns(content);
        var result = await Svc().GetPageContentAsync("about");
        Assert.True(result.IsSuccess);
    }

    [Fact]
    public async Task UpdatePageContent_GatewayFails_ReturnsInfraFailure()
    {
        var dto = new FsusBlog.Shared.Contracts.AuthSystem.PageContentContract();
        _gw.UpdatePageContentAsync(dto).Returns(false);
        var result = await Svc().UpdatePageContentAsync(dto);
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.InfraFailure, result.Error.Code);
    }

    [Fact]
    public async Task UpdatePageContent_Success()
    {
        var dto = new FsusBlog.Shared.Contracts.AuthSystem.PageContentContract();
        _gw.UpdatePageContentAsync(dto).Returns(true);
        Assert.True((await Svc().UpdatePageContentAsync(dto)).IsSuccess);
    }

    [Theory]
    [InlineData("")]
    [InlineData(null)]
    public async Task RefreshPageCache_EmptySlug_ReturnsValidationFailure(string? slug)
    {
        var result = await Svc().RefreshPageCacheAsync(slug!);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task RefreshPageCache_GatewayFails_ReturnsInfraFailure()
    {
        _gw.RefreshPageCacheAsync("about").Returns(false);
        var result = await Svc().RefreshPageCacheAsync("about");
        Assert.Equal(ErrorCode.InfraFailure, result.Error.Code);
    }

    [Fact]
    public async Task RefreshPageCache_Success()
    {
        _gw.RefreshPageCacheAsync("blog").Returns(true);
        Assert.True((await Svc().RefreshPageCacheAsync("blog")).IsSuccess);
    }
}
