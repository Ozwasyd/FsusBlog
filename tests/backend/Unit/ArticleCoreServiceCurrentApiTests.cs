using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Implementations;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public partial class ArticleCoreServiceTests
{
    [Theory]
    [InlineData(0, 10)]
    [InlineData(-1, 10)]
    [InlineData(1, 0)]
    [InlineData(1, -5)]
    [InlineData(1, 999999)]
    public async Task GetPageList_InvalidPagination_ReturnsValidationFailure(int page, int size)
    {
        var result = await Svc().GetPageListAsync(new ArticlePageQuery(page, size, null, null, false));
        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
    }

    [Fact]
    public async Task GetPageList_ValidParams_CallsGateway()
    {
        var emptyPage = new CorePageResult<ArticleListCoreModel>([], 0);
        var query = new ArticlePageQuery(1, 10, null, null, false);
        _gw.GetPageListAsync(query, Arg.Any<CancellationToken>()).Returns(emptyPage);

        var result = await Svc().GetPageListAsync(query);

        Assert.True(result.IsSuccess);
        Assert.Equal(0, result.Value!.Total);
    }

    [Fact]
    public async Task GetPageList_WithCategoryFilter_PassesThrough()
    {
        var page = new CorePageResult<ArticleListCoreModel>([], 5);
        var query = new ArticlePageQuery(
            Page: 2,
            Size: 20,
            CategoryId: 3,
            TagId: 7,
            IsDeleted: true,
            Status: ArticleStatusValues.Archived,
            IncludePrivate: true,
            Keyword: "  release  ",
            ListCacheVersion: 19,
            UseSourceCache: false);
        _gw.GetPageListAsync(query, Arg.Any<CancellationToken>()).Returns(page);

        var result = await Svc().GetPageListAsync(query);

        Assert.True(result.IsSuccess);
        Assert.Equal(5, result.Value!.Total);
        await _gw.Received(1).GetPageListAsync(
            Arg.Is<ArticlePageQuery>(actual =>
                actual.Page == 2 &&
                actual.Size == 20 &&
                actual.CategoryId == 3 &&
                actual.TagId == 7 &&
                actual.IsDeleted &&
                actual.Status == ArticleStatusValues.Archived &&
                actual.IncludePrivate &&
                actual.Keyword == "  release  " &&
                actual.ListCacheVersion == 19 &&
                !actual.UseSourceCache &&
                actual.Cursor == null),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetPageList_PublicUtcCursor_PassesCompositePositionToGateway()
    {
        var cursor = new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42);
        var query = new ArticlePageQuery(2, 10, null, null, false, Cursor: cursor);
        _gw.GetPageListAsync(query, Arg.Any<CancellationToken>())
            .Returns(new CorePageResult<ArticleListCoreModel>([], 0));

        Result<CorePageResult<ArticleListCoreModel>> result = await Svc().GetPageListAsync(query);

        Assert.True(result.IsSuccess);
        await _gw.Received(1).GetPageListAsync(query, Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task GetPageList_PublicPageAndCursorShape_FailsClosedBeforeGateway()
    {
        var cursor = new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42);

        Result<CorePageResult<ArticleListCoreModel>> deepWithoutCursor = await Svc().GetPageListAsync(
            new ArticlePageQuery(2, 10, null, null, false));
        Result<CorePageResult<ArticleListCoreModel>> firstWithCursor = await Svc().GetPageListAsync(
            new ArticlePageQuery(1, 10, null, null, false, Cursor: cursor));

        Assert.False(deepWithoutCursor.IsSuccess);
        Assert.Equal(ErrorCode.Validation, deepWithoutCursor.Error.Code);
        Assert.False(firstWithCursor.IsSuccess);
        Assert.Equal(ErrorCode.Validation, firstWithCursor.Error.Code);
        await _gw.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    public async Task GetPageList_AdminOrNonUtcCursor_FailsClosed()
    {
        var utcCursor = new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Utc), 42);
        var localCursor = new ArticleListCursorPosition(new DateTime(2026, 7, 20, 8, 0, 0, DateTimeKind.Local), 42);

        Result<CorePageResult<ArticleListCoreModel>> admin = await Svc().GetPageListAsync(
            new ArticlePageQuery(2, 10, null, null, false, IncludePrivate: true, Cursor: utcCursor));
        Result<CorePageResult<ArticleListCoreModel>> nonUtc = await Svc().GetPageListAsync(
            new ArticlePageQuery(2, 10, null, null, false, Cursor: localCursor));

        Assert.False(admin.IsSuccess);
        Assert.False(nonUtc.IsSuccess);
        await _gw.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    public void ArticleQueryAndCommand_DefaultsMatchCurrentPublicContract()
    {
        var page = new ArticlePageQuery(1, 10, null, null, false);
        var detail = new ArticleDetailQuery(42);
        var write = new ArticleWriteRequestCoreModel("title", "content", null, null, 7, [3, 2]);
        var update = new UpdateArticleCommand(42, write);
        var view = new ArticleViewCountCommand(42);

        Assert.Null(page.Status);
        Assert.False(page.IncludePrivate);
        Assert.Null(page.Keyword);
        Assert.Null(page.ListCacheVersion);
        Assert.True(page.UseSourceCache);
        Assert.Null(page.Cursor);
        Assert.False(detail.IncludePrivate);
        Assert.Equal(ArticleStatusValues.Published, write.Status);
        Assert.Null(write.ScheduledPublishAt);
        Assert.Null(write.Rights);
        Assert.Equal(ArticleRightsMutationMode.Preserve, write.RightsMutation);
        Assert.Null(write.BaseRevisionId);
        Assert.Equal(ArticleUpdateIntent.Standard, update.Intent);
        Assert.False(update.Force);
        Assert.Null(update.Rollback);
        Assert.Equal(1, view.Count);
    }

    [Fact]
    public async Task GetPageList_CancelledTokenFailsBeforeGateway()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Svc().GetPageListAsync(
            new ArticlePageQuery(1, 10, null, null, false),
            cts.Token));

        await _gw.DidNotReceiveWithAnyArgs().GetPageListAsync(default, default);
    }

    [Fact]
    public async Task Create_CommandPreservesFieldsAndCancellationToken()
    {
        using var cts = new CancellationTokenSource();
        DateTimeOffset clock = new(2026, 7, 19, 8, 0, 0, TimeSpan.Zero);
        DateTime scheduled = new(2026, 8, 1, 8, 0, 0, DateTimeKind.Utc);
        var rights = new ArticleRightsRequestCoreModel(
            true, "CC-BY-4.0", "Holder", 2026, "statement", "template", "append-attribution", 300, true, false, true);
        var article = new ArticleWriteRequestCoreModel(
            "scheduled", "body", "summary", "/cover.webp", 7, [5, 3], ArticleStatusValues.Scheduled,
            scheduled, rights, ArticleRightsMutationMode.Replace);
        var command = new CreateArticleCommand(article);
        _gw.CreateAsync(command, cts.Token).Returns(77);
        var service = new ArticleCoreService(_gw, new FixedTimeProvider(clock));

        Result<int> result = await service.CreateAsync(command, cts.Token);

        Assert.True(result.IsSuccess);
        Assert.Equal(77, result.Value);
        await _gw.Received(1).CreateAsync(
            Arg.Is<CreateArticleCommand>(actual =>
                actual.Article.Title == "scheduled" &&
                actual.Article.Content == "body" &&
                actual.Article.Summary == "summary" &&
                actual.Article.CoverImageUrl == "/cover.webp" &&
                actual.Article.CategoryId == 7 &&
                actual.Article.TagIds.SequenceEqual(new[] { 5, 3 }) &&
                actual.Article.Status == ArticleStatusValues.Scheduled &&
                actual.Article.ScheduledPublishAt == scheduled &&
                actual.Article.Rights == rights &&
                actual.Article.RightsMutation == ArticleRightsMutationMode.Replace &&
                actual.Article.BaseRevisionId == null),
            cts.Token);
    }

    [Fact]
    public async Task Create_BaseRevisionContextIsRejectedBeforeGateway()
    {
        var command = new CreateArticleCommand(new ArticleWriteRequestCoreModel(
            "title", "content", null, null, 1, [], BaseRevisionId: 9));

        Result<int> result = await Svc().CreateAsync(command);

        Assert.False(result.IsSuccess);
        Assert.Equal(ErrorCode.Validation, result.Error.Code);
        Assert.Equal("article_base_revision_not_allowed_on_create", result.Error.Message);
        await _gw.DidNotReceiveWithAnyArgs().CreateAsync(default);
    }

    [Fact]
    public async Task Update_StandardRequiresBaseRevisionUnlessForceIsExplicit()
    {
        var command = new UpdateArticleCommand(
            42,
            new ArticleWriteRequestCoreModel("t", "c", null, null, 1, []));

        Result result = await Svc().UpdateAsync(command);

        Assert.False(result.IsSuccess);
        Assert.Equal("article_base_revision_required", result.Error.Message);
        await _gw.DidNotReceiveWithAnyArgs().UpdateAsync(default);
    }

    [Fact]
    public async Task Update_RollbackPreservesActorContextIntentAndCancellationToken()
    {
        using var cts = new CancellationTokenSource();
        var rollback = new ArticleRollbackMetadata(17, 29, "restore reviewed package");
        var article = new ArticleWriteRequestCoreModel(
            "rollback", "body", null, null, 1, [], BaseRevisionId: 23);
        var command = new UpdateArticleCommand(
            42,
            article,
            Intent: ArticleUpdateIntent.Rollback,
            Rollback: rollback);
        _gw.UpdateAsync(command, cts.Token).Returns(true);

        Result result = await Svc().UpdateAsync(command, cts.Token);

        Assert.True(result.IsSuccess);
        await _gw.Received(1).UpdateAsync(
            Arg.Is<UpdateArticleCommand>(actual =>
                actual.Id == 42 &&
                actual.Article.BaseRevisionId == 23 &&
                actual.Intent == ArticleUpdateIntent.Rollback &&
                !actual.Force &&
                actual.Rollback == rollback &&
                actual.Rollback.Value.ActorAdminPrincipalId == 29),
            cts.Token);
    }

    [Theory]
    [InlineData(0, "restore reviewed package")]
    [InlineData(29, "short")]
    public async Task Update_RollbackRejectsInvalidActorOrReason(long actorAdminPrincipalId, string reason)
    {
        var command = new UpdateArticleCommand(
            42,
            new ArticleWriteRequestCoreModel("rollback", "body", null, null, 1, [], BaseRevisionId: 23),
            Intent: ArticleUpdateIntent.Rollback,
            Rollback: new ArticleRollbackMetadata(17, actorAdminPrincipalId, reason));

        Result result = await Svc().UpdateAsync(command);

        Assert.False(result.IsSuccess);
        Assert.Equal("article_rollback_metadata_invalid", result.Error.Message);
        await _gw.DidNotReceiveWithAnyArgs().UpdateAsync(default);
    }

    [Fact]
    public async Task Update_StandardRejectsRollbackActorContext()
    {
        var command = new UpdateArticleCommand(
            42,
            new ArticleWriteRequestCoreModel("standard", "body", null, null, 1, [], BaseRevisionId: 23),
            Rollback: new ArticleRollbackMetadata(17, 29, "unexpected rollback context"));

        Result result = await Svc().UpdateAsync(command);

        Assert.False(result.IsSuccess);
        Assert.Equal("article_rollback_metadata_unexpected", result.Error.Message);
        await _gw.DidNotReceiveWithAnyArgs().UpdateAsync(default);
    }

    [Fact]
    public async Task IncreaseViewCounts_CancelledEmptyBatchFailsBeforeGateway()
    {
        using var cts = new CancellationTokenSource();
        await cts.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await Svc().IncreaseViewCountsAsync(new ArticleViewCountBatchCommand(new Dictionary<int, int>()), cts.Token));

        await _gw.DidNotReceiveWithAnyArgs().IncreaseViewCountsAsync(default);
    }
}
