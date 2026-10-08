using System.Linq.Expressions;
using System.Reflection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Tests CommentCommandService validation paths that return early before any DB query.
/// </summary>
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public class CommentServiceValidationTests(PostgresSchemaMigrationFixture fixture)
{
    private static CommentCommandService BuildService()
    {
        var db = Substitute.For<ISqlSugarClient>();
        var notifications = Substitute.For<ICommentNotificationService>();
        var invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        return new CommentCommandService(
            db: db,
            logger: NullLogger<CommentCommandService>.Instance,
            commentNotifications: notifications,
            commentModeration: new CommentModerationService(
                db,
                new RegionLegalModerationService(),
                invalidations,
                notifications,
                NullLogger<CommentModerationService>.Instance),
            commentAttribution: new CommentAttributionPrivacyService(
                NullLogger<CommentAttributionPrivacyService>.Instance),
            cacheInvalidationDispatcher: invalidations);
    }

    private static CommentQueryService BuildQueryService()
        => new(Substitute.For<ISqlSugarClient>(), new RegionLegalModerationService());

    private static CursorPageRequest<long> MakeRequest(int limit = 10)
        => new(null, null, limit);

    // ─── CreateCommentAsync early returns ────────────────────────────────────

    [Fact]
    public async Task CreateComment_ArticleIdZero_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 0, Content = "valid content" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_NegativeArticleId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = -5, Content = "valid content" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_EmptyContent_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "   " };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Theory]
    [InlineData("not-numeric", "not-a-number")]
    [InlineData("zero", "0")]
    [InlineData("negative", "-1")]
    public async Task CreateComment_ParentIdBoundary_ReturnsFalseWithoutSideEffects(
        string caseName,
        string parentId)
    {
        CreateCommentValidationFixture testFixture = BuildCreateCommentValidationFixture();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = parentId };

        bool result = await testFixture.Service.CreateCommentAsync(1, dto);

        Assert.False(result, $"parent ID case '{caseName}' must be rejected");
        testFixture.Moderation.Received(1).ResolveSubmissionRegion("hello", 1, 1, null);
        await testFixture.Attribution.Received(1).ResolvePublicActorAsync(
            1,
            Arg.Is<CommentDto>(request =>
                request.ArticleId == 1
                && request.Content == "hello"
                && request.ParentId == parentId
                && request.RootId == null
                && request.ReplyToCommentId == null),
            "hello",
            RegionCodes.Unknown,
            Arg.Any<CancellationToken>());
        testFixture.Attribution.Received(1).RequiresAnonymousNullifierEnforcement(testFixture.Actor);
        Assert.Equal(
            [nameof(ISqlSugarClient.Queryable)],
            testFixture.Database.ReceivedCalls().Select(static call => call.GetMethodInfo().Name));
        Assert.Equal(
            [nameof(ISugarQueryable<Article>.Where), nameof(ISugarQueryable<Article>.AnyAsync)],
            testFixture.Articles.ReceivedCalls().Select(static call => call.GetMethodInfo().Name));
        Assert.Empty(testFixture.Notifications.ReceivedCalls());
        Assert.Empty(testFixture.Invalidations.ReceivedCalls());
        Assert.Empty(testFixture.Outbox.ReceivedCalls());
        Assert.Single(testFixture.Moderation.ReceivedCalls());
        Assert.Equal(
            [nameof(ICommentAttributionPrivacyService.ResolvePublicActorAsync), nameof(ICommentAttributionPrivacyService.RequiresAnonymousNullifierEnforcement)],
            testFixture.Attribution.ReceivedCalls().Select(static call => call.GetMethodInfo().Name));
    }

    [Theory]
    [InlineData("not-numeric", "abc")]
    [InlineData("negative", "-5")]
    public async Task CreateComment_RootIdBoundary_ReturnsFalseWithoutSideEffects(
        string caseName,
        string rootId)
    {
        CreateCommentValidationFixture testFixture = BuildCreateCommentValidationFixture();
        var dto = new CommentDto
        {
            ArticleId = 1,
            Content = "hello",
            ParentId = "100",
            RootId = rootId
        };

        bool result = await testFixture.Service.CreateCommentAsync(1, dto);

        Assert.False(result, $"root ID case '{caseName}' must be rejected");
        testFixture.Moderation.Received(1).ResolveSubmissionRegion("hello", 1, 1, null);
        await testFixture.Attribution.Received(1).ResolvePublicActorAsync(
            1,
            Arg.Is<CommentDto>(request =>
                request.ArticleId == 1
                && request.Content == "hello"
                && request.ParentId == "100"
                && request.RootId == rootId
                && request.ReplyToCommentId == null),
            "hello",
            RegionCodes.Unknown,
            Arg.Any<CancellationToken>());
        testFixture.Attribution.Received(1).RequiresAnonymousNullifierEnforcement(testFixture.Actor);
        Assert.Equal(
            [nameof(ISqlSugarClient.Queryable)],
            testFixture.Database.ReceivedCalls().Select(static call => call.GetMethodInfo().Name));
        Assert.Equal(
            [nameof(ISugarQueryable<Article>.Where), nameof(ISugarQueryable<Article>.AnyAsync)],
            testFixture.Articles.ReceivedCalls().Select(static call => call.GetMethodInfo().Name));
        Assert.Empty(testFixture.Notifications.ReceivedCalls());
        Assert.Empty(testFixture.Invalidations.ReceivedCalls());
        Assert.Empty(testFixture.Outbox.ReceivedCalls());
        Assert.Single(testFixture.Moderation.ReceivedCalls());
        Assert.Equal(
            [nameof(ICommentAttributionPrivacyService.ResolvePublicActorAsync), nameof(ICommentAttributionPrivacyService.RequiresAnonymousNullifierEnforcement)],
            testFixture.Attribution.ReceivedCalls().Select(static call => call.GetMethodInfo().Name));
    }

    [Fact]
    public async Task CreateComment_InvalidReplyToCommentId_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = "hello", ParentId = "100", ReplyToCommentId = "bad" };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    [Fact]
    public async Task CreateComment_NullContent_ReturnsFalse()
    {
        var svc = BuildService();
        var dto = new CommentDto { ArticleId = 1, Content = null! };
        bool result = await svc.CreateCommentAsync(1, dto);
        Assert.False(result);
    }

    // ─── GetCommentThreadsByCursorAsync guard ────────────────────────────────

    [Fact]
    public async Task GetCommentThreads_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetThreadsAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetCommentThreads_NegativeArticleId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetThreadsAsync(-1, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    // ─── GetThreadRepliesByCursorAsync guard ─────────────────────────────────

    [Fact]
    public async Task GetThreadReplies_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(0, 1L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_RootIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(1, 0L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_NegativeRootId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(1, -100L, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public async Task GetThreadReplies_BothNegative_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetRepliesAsync(-1, -1L, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    // ─── GetAttributableCommentsAsync guard ─────────────────────────────────

    [Fact]
    public async Task GetAttributableComments_UserIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetAttributableAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.Null(result.NextCursor);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetAttributableComments_NegativeUserId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetAttributableAsync(-99, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    // ─── GetCommentsByCursorAsync delegates to GetCommentThreads ─────────────

    [Fact]
    public async Task GetCommentsByCursor_ArticleIdZero_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetLegacyCommentsAsync(0, MakeRequest());
        Assert.Empty(result.Data);
        Assert.False(result.HasMore);
    }

    [Fact]
    public async Task GetCommentsByCursor_NegativeArticleId_ReturnsEmpty()
    {
        var svc = BuildQueryService();
        var result = await svc.GetLegacyCommentsAsync(-5, MakeRequest());
        Assert.Empty(result.Data);
    }

    [Fact]
    public void CommentCursorQueries_UseIndexedKeysetPredicates()
    {
        string roots = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "c.id < @Cursor",
            "ORDER BY c.id DESC");
        string replies = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "c.id > @Cursor",
            "ORDER BY c.id");
        string publicPaging = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentQueryService),
            nameof(CommentQueryService.GetThreadsAsync),
            nameof(CommentQueryService.GetRepliesAsync),
            nameof(CommentQueryService.GetAttributableAsync));

        Assert.Contains("c.id < @Cursor", roots);
        Assert.Contains("c.id > @Cursor", replies);
        Assert.Contains("SliceMapToResponse", publicPaging);
        Assert.DoesNotContain("Enumerable.Skip", roots, StringComparison.Ordinal);
        Assert.DoesNotContain("Enumerable.Skip", replies, StringComparison.Ordinal);
        Assert.DoesNotContain(" OFFSET ", roots, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(" OFFSET ", replies, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CommentThreadPreviewQuery_UsesSqlPerRootWindowLimit()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)",
            "WHERE x.rn <= @PreviewLimit");

        Assert.Contains("ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)", runtimeShape);
        Assert.Contains("WHERE x.rn <= @PreviewLimit", runtimeShape);
        Assert.DoesNotContain("List.get_Count", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicReplyReadQueries_DoNotProjectReplyToUserIdForAuthorNames()
    {
        string repliesQuery = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id",
            "c.id > @Cursor");
        string previewQuery = RuntimeMetadataInspection.DescribeDeclaredMethodContaining(
            typeof(CommentQueryService),
            "LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id",
            "ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.id)");

        Assert.DoesNotContain("reply_to_user_id", repliesQuery, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ReplyToUserId", repliesQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("reply_to_user_id", previewQuery, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("ReplyToUserId", previewQuery, StringComparison.Ordinal);
        Assert.DoesNotContain("sys_user", repliesQuery, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sys_user", previewQuery, StringComparison.OrdinalIgnoreCase);

        Assert.Contains("LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id", repliesQuery, StringComparison.Ordinal);
        Assert.Contains("LEFT JOIN comment pc ON c.reply_to_comment_id = pc.id", previewQuery, StringComparison.Ordinal);
        Assert.Contains("pc.public_handle", repliesQuery, StringComparison.Ordinal);
        Assert.Contains("pc.anonymous_display_name", repliesQuery, StringComparison.Ordinal);
        Assert.Contains("pc.public_handle", previewQuery, StringComparison.Ordinal);
        Assert.Contains("pc.anonymous_display_name", previewQuery, StringComparison.Ordinal);
    }

    // Note: DeleteCommentAsync always queries DB first, so no pure validation path to test without DB mock

    // ── Private static helpers via reflection ──────────────────────────────────

    private static T InvokePrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(CommentCommandService).GetMethod(methodName, BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }

    [Theory]
    [InlineData(7, 8, 7)]
    [InlineData(7, null, 7)]
    [InlineData(null, 8, null)]
    [InlineData(null, null, null)]
    [InlineData(7, 7, null)]
    public void ResolveReplyRecipientId_DependsOnlyOnTargetAndExcludesPublicSelfReply(
        int? targetAuthorAccountId,
        int? replyingActorAccountId,
        int? expected)
    {
        int? actual = CommentCommandService.ResolveReplyRecipientId(
            targetAuthorAccountId,
            replyingActorAccountId);

        Assert.Equal(expected, actual);
    }

    [Fact]
    public async Task ApprovedReplyNotification_UsesTransitionScopedIdentityAndCarriesCommentLocation()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(Article),
            typeof(Comment),
            typeof(CommentRegionCompliance),
            typeof(CommentModerationEvent));
        DateTime createdAt = DateTime.UtcNow.AddMinutes(-1);
        await db.Insertable(new Article
        {
            Id = 42,
            Title = "Notification article",
            CategoryId = 1,
            Views = 0,
            CreateTime = createdAt,
            Status = ArticleStatus.Published,
            PublishedAt = createdAt
        }).ExecuteCommandAsync();
        await db.Insertable(new[]
        {
            new Comment
            {
                Id = 100,
                ArticleId = 42,
                UserId = 7,
                AuthorMode = CommentAuthorModes.Public,
                PublicHandle = "target-user",
                Content = "parent",
                CreateTime = createdAt,
                ModerationStatus = CommentModerationStatus.Approved
            },
            new Comment
            {
                Id = 101,
                ArticleId = 42,
                UserId = 8,
                AuthorMode = CommentAuthorModes.Public,
                PublicHandle = "reply-user",
                Content = "approved reply",
                CreateTime = createdAt,
                ParentId = 100,
                RootId = 100,
                ReplyToCommentId = 100,
                ReplyToUserId = 7,
                Depth = 1,
                ModerationStatus = CommentModerationStatus.Pending
            }
        }).ExecuteCommandAsync();
        var contentFilter = Substitute.For<IContentFilterService>();
        contentFilter.ValidateContent(Arg.Any<string>())
            .Returns(new ContentValidationResult(true, string.Empty, string.Empty));
        IMessageCommandService commands = Substitute.For<IMessageCommandService>();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        var service = new AuthoringModerationWorkflowService(
            db,
            contentFilter,
            Substitute.For<IBanStateProjectionObligationCoordinator>(),
            Substitute.For<ICacheInvalidationDispatcher>(),
            realtime,
            commands,
            new AuthoringAuditWriter(new AuditLogChannel()),
            NullLogger<AuthoringModerationWorkflowService>.Instance);

        Assert.True(await service.ModerateCommentAsync(
            9,
            101,
            new CommentModerationRequest(CommentModerationStatus.Approved, "reviewed")));
        Assert.False(await service.ModerateCommentAsync(
            9,
            101,
            new CommentModerationRequest(CommentModerationStatus.Approved, "duplicate")));

        await commands.Received(1).SendAccountTransactionalNoticeAsync(
            7,
            "收到新的评论回复",
            Arg.Is<string>(body => body.Contains("/article/42#comment-101", StringComparison.Ordinal)));
        await realtime.Received(1).PushCommentAddAsync(
            Arg.Is<CommentAddedNotifyDto>(notification => notification.Comment.Depth == 1));
    }

    private static T InvokeAttributionPrivateStatic<T>(string methodName, object?[] args)
    {
        var method = typeof(CommentAttributionPrivacyService).GetMethod(
            methodName,
            BindingFlags.NonPublic | BindingFlags.Static)!;
        return (T)method.Invoke(null, args)!;
    }
    [Theory]
    [InlineData(null, "")]
    [InlineData("   ", "")]
    [InlineData("hello", "hello")]
    [InlineData("  trimmed  ", "trimmed")]
    public void NormalizeCommentContent_ReturnsExpected(string? input, string expected)
    {
        var result = InvokePrivateStatic<string>("NormalizeCommentContent", [input]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void NormalizeCommentContent_DoesNotTruncateOversizedInput()
    {
        string longContent = new string('a', 5000);
        var result = InvokePrivateStatic<string>("NormalizeCommentContent", [longContent]);
        Assert.Equal(5000, result.Length);
    }

    [Theory]
    [InlineData("hello", true)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    public void IsCommentContentWithinLimit_ReturnsExpectedForBasicInputs(string content, bool expected)
    {
        var result = InvokeAttributionPrivateStatic<bool>("IsContentWithinLimit", [content, AnonymousCommentPolicySnapshot.Default]);
        Assert.Equal(expected, result);
    }

    [Fact]
    public void IsCommentContentWithinLimit_RejectsOverCharacterLimit()
    {
        string longContent = new('a', AnonymousCommentPolicySnapshot.Default.CommentMaxChars + 1);
        var result = InvokeAttributionPrivateStatic<bool>("IsContentWithinLimit", [longContent, AnonymousCommentPolicySnapshot.Default]);
        Assert.False(result);
    }

    [Fact]
    public void IsCommentContentWithinLimit_RejectsOverUtf8ByteLimit()
    {
        string longContent = new('你', (AnonymousCommentPolicySnapshot.Default.CommentMaxUtf8Bytes / 3) + 1);
        var result = InvokeAttributionPrivateStatic<bool>("IsContentWithinLimit", [longContent, AnonymousCommentPolicySnapshot.Default]);
        Assert.False(result);
    }

    [Theory]
    [InlineData(true, "content", "该回复已删除")]
    [InlineData(false, "original", "original")]
    public void ToDisplayContent_ReturnsExpected(bool isDeleted, string content, string expected)
    {
        MethodInfo method = typeof(CommentQueryService).GetMethod(
            "ToDisplayContent",
            BindingFlags.NonPublic | BindingFlags.Static)!;
        var result = (string)method.Invoke(null, [(object)isDeleted, content])!;
        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("", false)]
    [InlineData("   ", false)]
    [InlineData("0", false)]
    [InlineData("-1", false)]
    [InlineData("abc", false)]
    [InlineData("123", true)]
    [InlineData("9999999", true)]
    public void TryParsePositiveCommentId_ReturnsExpected(string? raw, bool expectedSuccess)
    {
        var method = typeof(CommentCommandService).GetMethod("TryParsePositiveCommentId", BindingFlags.NonPublic | BindingFlags.Static)!;
        var args = new object?[] { raw, (long)0 };
        var result = (bool)method.Invoke(null, args)!;
        Assert.Equal(expectedSuccess, result);
    }

    private static CreateCommentValidationFixture BuildCreateCommentValidationFixture()
    {
        var database = Substitute.For<ISqlSugarClient>();
        var articles = Substitute.For<ISugarQueryable<Article>>();
        database.Queryable<Article>().Returns(articles);
        articles.Where(Arg.Any<Expression<Func<Article, bool>>>()).Returns(articles);
        articles.AnyAsync().Returns(Task.FromResult(true));

        var moderation = Substitute.For<ICommentModerationService>();
        moderation.ResolveSubmissionRegion("hello", 1, 1, null).Returns(new RegionModerationDecision(
            CanPublish: true,
            SubmitRegion: RegionCodes.Unknown,
            SubmitRegionConfidence: 0d,
            RegionProvider: "test",
            SubmitIpHash: null,
            BlockedRegions: [],
            RiskLabels: [],
            RuleHits: [],
            PolicyVersion: "test-v1",
            DecisionReason: "allowed",
            PublicReason: "allowed",
            RequiresManualReview: false,
            HideUntilReviewed: false));

        var actor = new CommentActor(
            UserId: 1,
            AuthorMode: CommentAuthorModes.Public,
            PublicHandle: "writer",
            AnonymousHandle: null,
            DisplayName: "writer",
            DisplayLanguage: "zh-CN",
            AnonymousNullifierHash: null,
            AnonymousScope: null,
            ModerationSubjectHash: "writer-subject",
            RateClass: "common",
            RequiresModeration: false);
        var attribution = Substitute.For<ICommentAttributionPrivacyService>();
        attribution.ResolvePublicActorAsync(
                1,
                Arg.Any<CommentDto>(),
                "hello",
                RegionCodes.Unknown,
                Arg.Any<CancellationToken>())
            .Returns(actor);
        attribution.RequiresAnonymousNullifierEnforcement(actor).Returns(false);

        var notifications = Substitute.For<ICommentNotificationService>();
        var invalidations = Substitute.For<ICacheInvalidationDispatcher>();
        var outbox = Substitute.For<ICommentMutationOutbox>();
        var service = new CommentCommandService(
            database,
            NullLogger<CommentCommandService>.Instance,
            notifications,
            moderation,
            attribution,
            invalidations,
            mutationOutbox: outbox);

        database.ClearReceivedCalls();
        articles.ClearReceivedCalls();
        moderation.ClearReceivedCalls();
        attribution.ClearReceivedCalls();
        notifications.ClearReceivedCalls();
        invalidations.ClearReceivedCalls();
        outbox.ClearReceivedCalls();
        return new(
            service,
            database,
            articles,
            moderation,
            attribution,
            actor,
            notifications,
            invalidations,
            outbox);
    }

    private sealed record CreateCommentValidationFixture(
        CommentCommandService Service,
        ISqlSugarClient Database,
        ISugarQueryable<Article> Articles,
        ICommentModerationService Moderation,
        ICommentAttributionPrivacyService Attribution,
        CommentActor Actor,
        ICommentNotificationService Notifications,
        ICacheInvalidationDispatcher Invalidations,
        ICommentMutationOutbox Outbox);
}
