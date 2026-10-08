using System.Globalization;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class AnonymousCommentSubmitTests(
    PostgresSchemaMigrationFixture fixture,
    AnonymousCommentSubmitDatabaseFixture classDatabase)
    : IClassFixture<AnonymousCommentSubmitDatabaseFixture>, IAsyncLifetime
{
    private static readonly byte[] s_ticket = Enumerable.Range(0, 32).Select(static value => (byte)(value + 1)).ToArray();
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-region-hide-until-reviewed-writes-hidden-without-public-invalidation")]
    public async Task CreateStrongAnonymousCommentAsync_RegionHideUntilReviewed_WritesHiddenWithoutPublicInvalidation()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42));
        var nullifiers = new RecordingNullifierService();
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentCommandService service = CreateService(db, tickets, nullifiers, dispatcher);

        bool created = await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.True(created);
        Comment comment = Assert.Single(db.Queryable<Comment>().ToList());
        Assert.Null(comment.UserId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, comment.AuthorMode);
        Assert.Equal(NullifierHash, comment.AnonymousNullifierHash);
        Assert.Equal("comment:v1:article:42:top", comment.AnonymousScope);
        Assert.Null(comment.CredentialLevel);
        Assert.Null(comment.ReputationBucket);
        Assert.Null(comment.AccountAgeBucket);
        Assert.Equal(AnonymousPrivacyContract.CommonRateClass, comment.AnonymousRateClass);
        Assert.False(comment.AnonymousRequiresModeration);
        Assert.Equal(
            Convert.ToHexStringLower(HMACSHA256.HashData(
                Encoding.UTF8.GetBytes(ModerationPepper),
                Encoding.UTF8.GetBytes(NullifierHash))),
            comment.ModerationSubjectHash);
        Assert.Equal(CommentModerationStatus.Hidden, comment.ModerationStatus);
        Assert.DoesNotContain(Convert.ToHexString(s_ticket), comment.Content, StringComparison.OrdinalIgnoreCase);

        CommentRegionCompliance compliance = Assert.Single(db.Queryable<CommentRegionCompliance>().ToList());
        Assert.Equal(comment.Id, compliance.CommentId);
        Assert.Equal(RegionCodes.Singapore, compliance.SubmitRegion);
        Assert.True(compliance.CanPublish);

        var consume = Assert.Single(nullifiers.Consumes);
        Assert.Equal(NullifierHash, consume.NullifierHash);
        Assert.Equal("comment:v1:article:42:top", consume.Scope);
        Assert.Equal(comment.Id, consume.CommentId);
        Assert.Empty(nullifiers.Reservations);
        Assert.Empty(nullifiers.Increments);

        CommentCacheInvalidationScope scope = Assert.Single(dispatcher.CommentScopes)!;
        Assert.Equal(42, scope.ArticleId);
        Assert.Equal(comment.Id, scope.RootId);
        Assert.Null(scope.AccountId);
        Assert.False(scope.PublicArticleChanged);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CreateStrongAnonymousCommentAsync_RuntimeUsesAtomicNullifierConsume()
    {
        string create = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentCommandService),
            "CreateResolvedCommentAsync");
        string attribution = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentAttributionPrivacyService),
            "ConsumeAnonymousNullifierAsync");
        string nullifier = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentAnonymousNullifierService),
            nameof(CommentAnonymousNullifierService.TryConsumeAsync));
        HashSet<string> instruments = typeof(FsusObservability)
            .GetFields(BindingFlags.Static | BindingFlags.NonPublic)
            .Select(static field => field.GetValue(null))
            .OfType<System.Diagnostics.Metrics.Instrument>()
            .Select(static instrument => instrument.Name)
            .ToHashSet(StringComparer.Ordinal);

        Assert.Contains("ConsumeAnonymousNullifierAsync", create, StringComparison.Ordinal);
        Assert.Contains("TryConsumeAsync", attribution, StringComparison.Ordinal);
        Assert.DoesNotContain("CheckAndReserveAsync", create, StringComparison.Ordinal);
        Assert.DoesNotContain("IncrementUsageAsync", create, StringComparison.Ordinal);
        Assert.Contains("WITH consumed AS", nullifier, StringComparison.Ordinal);
        Assert.Contains("ON CONFLICT (nullifier_hash, scope) DO UPDATE", nullifier, StringComparison.Ordinal);
        Assert.Contains("use_count = comment_anonymous_nullifier.use_count + 1", nullifier, StringComparison.Ordinal);
        Assert.Contains("first_comment_id = COALESCE(comment_anonymous_nullifier.first_comment_id, @CommentId)", nullifier, StringComparison.Ordinal);
        Assert.Contains("RecordAnonymousNullifierAtomicIncrement", nullifier, StringComparison.Ordinal);
        Assert.Contains("fsus.anonymous_nullifier.precheck_count", instruments);
        Assert.Contains("fsus.anonymous_nullifier.atomic_increment_elapsed_ms", instruments);
        Assert.Contains("fsus.anonymous_nullifier.scope_limit_rejected_count", instruments);
        Assert.Contains("fsus.anonymous_nullifier.blocked_rejected_count", instruments);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task CommentAnonymousNullifierService_TryConsumeAsync_InsertsAndLinksFirstUse()
    {
        using SqlSugarClient db = await CreateDbAsync();
        PostgresSqlSugarTestClient.InitTables(db, typeof(CommentAnonymousNullifier));
        var service = new CommentAnonymousNullifierService(db, BuildConfiguration());

        NullifierReservationResult result = await service.TryConsumeAsync(
            NullifierHash,
            "comment:v1:article:42:top",
            commentId: 1234,
            CancellationToken.None);

        Assert.True(result.Allowed);
        Assert.Equal("reserved", result.Status);
        Assert.Equal(1, result.CurrentUseCount);
        CommentAnonymousNullifier row = Assert.Single(db.Queryable<CommentAnonymousNullifier>().ToList());
        Assert.Equal(NullifierHash, row.NullifierHash);
        Assert.Equal("comment:v1:article:42:top", row.Scope);
        Assert.Equal(1, row.UseCount);
        Assert.Equal(1234, row.FirstCommentId);
        Assert.Equal(1234, row.LastCommentId);
        Assert.False(row.Blocked);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task CreateStrongAnonymousCommentAsync_ReplayedTicket_ReturnsOriginalResultWithoutSecondWrite()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42));
        CommentCommandService service = CreateService(db, tickets);

        CommentCreateResult created = await service.CreateStrongAnonymousCommentResultAsync(CreateRequest(), RegionDecision(), CancellationToken.None);
        CommentCreateResult replay = await service.CreateStrongAnonymousCommentResultAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.True(created.Created);
        Assert.True(replay.Created);
        Assert.False(created.IdempotencyReplay);
        Assert.True(replay.IdempotencyReplay);
        Assert.Equal(created.CommentId, replay.CommentId);
        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Equal(2, tickets.ConsumeAttempts);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-expired-ticket-is-rejected-without-comment-or-usage-increment")]
    public async Task CreateStrongAnonymousCommentAsync_ExpiredTicket_IsRejectedWithoutCommentOrUsageIncrement()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42, expiresAtUnixMs: DateTimeOffset.UtcNow.AddSeconds(-1).ToUnixTimeMilliseconds()));
        var nullifiers = new RecordingNullifierService();
        CommentCommandService service = CreateService(db, tickets, nullifiers);

        bool created = await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Empty(nullifiers.Increments);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-ticket-reply-context-mismatch-is-rejected")]
    public async Task CreateStrongAnonymousCommentAsync_TicketReplyContextMismatch_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentCommandService service = CreateService(db, tickets);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "101", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, db.Queryable<Comment>().Count());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-valid-reply-to-public-target-preserves-recipient-without-attributing-actor")]
    public async Task CreateStrongAnonymousCommentAsync_ValidReplyToPublicTarget_PreservesRecipientWithoutAttributingActor()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedLegacyUser(db, userId: 7, username: "target-user");
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentCommandService service = CreateService(db, tickets);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.True(created);
        Comment reply = db.Queryable<Comment>().OrderBy(static item => item.Id, OrderByType.Desc).First();
        Assert.Null(reply.UserId);
        Assert.Equal(100, reply.ParentId);
        Assert.Equal(100, reply.RootId);
        Assert.Equal(100, reply.ReplyToCommentId);
        Assert.Equal(7, reply.ReplyToUserId);
        Assert.Equal(1, reply.Depth);

        await db.Updateable<Comment>()
            .SetColumns(static item => item.ModerationStatus == CommentModerationStatus.Approved)
            .Where(item => item.Id == reply.Id)
            .ExecuteCommandAsync();

        var queries = new CommentQueryService(db, new RegionLegalModerationService());
        CursorResponse<CommentReplyItemDto> replies = await queries.GetRepliesAsync(
            42,
            100,
            new CursorPageRequest<long> { Limit = 5 });
        CommentReplyItemDto visibleReply = Assert.Single(replies.Data);
        Assert.Equal(CommentAuthorModes.Public, visibleReply.ReplyToAuthor?.Mode);
        Assert.Equal("parent-user", visibleReply.ReplyToAuthor?.DisplayName);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-reply-to-anonymous-target-does-not-invent-recipient-mapping")]
    public async Task CreateStrongAnonymousCommentAsync_ReplyToAnonymousTarget_DoesNotInventRecipientMapping()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: null);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentCommandService service = CreateService(db, tickets);

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100"),
            RegionDecision(),
            CancellationToken.None);

        Assert.True(created);
        Comment reply = db.Queryable<Comment>().OrderBy(static item => item.Id, OrderByType.Desc).First();
        Assert.Null(reply.UserId);
        Assert.Null(reply.ReplyToUserId);
        Assert.Equal(100, reply.ReplyToCommentId);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-reply-to-deleted-account-target-drops-recipient-but-keeps-comment-target")]
    public async Task CreateStrongAnonymousCommentAsync_ReplyToDeletedAccountTarget_DropsRecipientButKeepsCommentTarget()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedLegacyUser(db, userId: 7, username: "retired-target", status: 2, deletedAt: DateTime.UtcNow);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(s_ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentCommandService service = CreateService(db, tickets);

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100"),
            RegionDecision(),
            CancellationToken.None);

        Assert.True(created);
        Comment reply = db.Queryable<Comment>().OrderBy(static item => item.Id, OrderByType.Desc).First();
        Assert.Null(reply.ReplyToUserId);
        Assert.Equal(100, reply.ReplyToCommentId);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-article-deleted-after-precheck-is-rejected")]
    public async Task CreateStrongAnonymousCommentAsync_ArticleDeletedAfterPrecheck_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService(onConsumeAsync: () => db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET isdeleted = true
            WHERE id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", 42)));
        tickets.Add(s_ticket, TicketPayload(articleId: 42));
        var nullifiers = new RecordingNullifierService();
        CommentCommandService service = CreateService(db, tickets, nullifiers);

        bool created = await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.True(db.Queryable<Article>().InSingle(42).IsDeleted);
        Assert.Empty(nullifiers.Increments);
        Assert.Empty(nullifiers.Consumes);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-parent-hidden-after-precheck-is-rejected")]
    public async Task CreateStrongAnonymousCommentAsync_ParentHiddenAfterPrecheck_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService(onConsumeAsync: () => db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment
            SET moderation_status = @HiddenStatus
            WHERE id = @ParentId;
            """,
            new SugarParameter("@HiddenStatus", (int)CommentModerationStatus.Hidden),
            new SugarParameter("@ParentId", 100L)));
        tickets.Add(s_ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        var nullifiers = new RecordingNullifierService();
        CommentCommandService service = CreateService(db, tickets, nullifiers);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Equal(CommentModerationStatus.Hidden, db.Queryable<Comment>().InSingle(100).ModerationStatus);
        Assert.Empty(nullifiers.Increments);
        Assert.Empty(nullifiers.Consumes);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-create-strong-anonymous-comment-async-parent-deleted-after-precheck-is-rejected")]
    public async Task CreateStrongAnonymousCommentAsync_ParentDeletedAfterPrecheck_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService(onConsumeAsync: () => db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment
            SET is_deleted = true
            WHERE id = @ParentId;
            """,
            new SugarParameter("@ParentId", 100L)));
        tickets.Add(s_ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        var nullifiers = new RecordingNullifierService();
        CommentCommandService service = CreateService(db, tickets, nullifiers);

        bool created = await service.CreateStrongAnonymousCommentAsync(
            CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100"),
            RegionDecision(),
            CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.True(db.Queryable<Comment>().InSingle(100).IsDeleted);
        Assert.Empty(nullifiers.Consumes);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-comment-threads-by-cursor-async-legacy-user-name-fallback-is-not-publicly-exposed")]
    public async Task GetCommentThreadsByCursorAsync_LegacyUserNameFallback_IsNotPubliclyExposed()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedLegacyUser(db, userId: 7, username: "legacy_real_name");
        SeedVisibleComment(
            db,
            commentId: 100,
            articleId: 42,
            userId: 7,
            content: "legacy snapshot root",
            authorMode: CommentAuthorModes.ZkAnonymous,
            publicHandle: null,
            anonymousDisplayName: null,
            anonymousDisplayLanguage: "zh-CN",
            anonymousScope: "article:42",
            credentialLevel: AnonymousCredentialLevels.StrongAnonymous);
        CommentCommandService service = CreateService(db, new RecordingTicketService());

        var queries = new CommentQueryService(db, new RegionLegalModerationService());
        CursorResponse<CommentThreadItemDto> result = await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 });

        CommentThreadItemDto item = Assert.Single(result.Data);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, item.Author.Mode);
        Assert.Equal("匿名用户", item.Author.DisplayName);
        Assert.DoesNotContain("legacy_real_name", JsonSerializer.Serialize(item), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-thread-replies-by-cursor-async-reply-to-snapshot-missing-does-not-expose-legacy-parent-username")]
    public async Task GetThreadRepliesByCursorAsync_ReplyToSnapshotMissing_DoesNotExposeLegacyParentUsername()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedLegacyUser(db, userId: 7, username: "legacy_real_name");
        SeedVisibleComment(
            db,
            commentId: 100,
            articleId: 42,
            userId: 7,
            content: "legacy snapshot parent",
            authorMode: CommentAuthorModes.ZkAnonymous,
            publicHandle: null,
            anonymousDisplayName: null,
            anonymousDisplayLanguage: "zh-CN",
            anonymousScope: "article:42",
            credentialLevel: AnonymousCredentialLevels.StrongAnonymous);
        SeedVisibleComment(
            db,
            commentId: 101,
            articleId: 42,
            userId: null,
            content: "child reply",
            authorMode: CommentAuthorModes.ZkAnonymous,
            publicHandle: null,
            anonymousDisplayName: "匿名用户小溪",
            anonymousDisplayLanguage: "zh-CN",
            anonymousScope: "article:42",
            credentialLevel: AnonymousCredentialLevels.StrongAnonymous,
            parentId: 100,
            rootId: 100,
            replyToCommentId: 100,
            depth: 1);
        CommentCommandService service = CreateService(db, new RecordingTicketService());

        var queries = new CommentQueryService(db, new RegionLegalModerationService());
        CursorResponse<CommentReplyItemDto> result = await queries.GetRepliesAsync(
            42,
            100,
            new CursorPageRequest<long> { Limit = 10 });

        CommentReplyItemDto reply = Assert.Single(result.Data);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, reply.ReplyToAuthor?.Mode);
        Assert.Equal("匿名用户", reply.ReplyToAuthor?.DisplayName);
        Assert.DoesNotContain("legacy_real_name", JsonSerializer.Serialize(reply), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-public-comment-read-deleted-root-and-middle-with-visible-descendant-returns-opaque-tombstone-chain")]
    public async Task PublicCommentRead_DeletedRootAndMiddleWithVisibleDescendant_ReturnsOpaqueTombstoneChain()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedPublicComment(db, 100, 42, "root secret", "root-author");
        SeedPublicComment(db, 101, 42, "middle secret", "middle-author", parentId: 100, rootId: 100, replyToCommentId: 100, depth: 1);
        SeedPublicComment(db, 102, 42, "visible child", "child-author", parentId: 101, rootId: 100, replyToCommentId: 101, depth: 2);
        TombstoneComment(db, 100);
        TombstoneComment(db, 101);
        var queries = new CommentQueryService(db, new RegionLegalModerationService());

        CursorResponse<CommentThreadItemDto> threads = await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 },
            previewLimit: 10);
        CommentThreadItemDto root = Assert.Single(threads.Data);
        Assert.True(root.IsDeleted);
        Assert.Equal("该回复已删除", root.Content);
        Assert.Equal("已删除评论", root.Author.DisplayName);
        Assert.DoesNotContain("root secret", JsonSerializer.Serialize(root), StringComparison.Ordinal);
        Assert.Equal(2, root.ReplyCount);
        Assert.Equal(2, root.RepliesPreview.Count);
        Assert.True(root.RepliesPreview[0].IsDeleted);
        Assert.Equal("该回复已删除", root.RepliesPreview[0].Content);
        Assert.Equal("visible child", root.RepliesPreview[1].Content);
        Assert.Equal("已删除评论", root.RepliesPreview[1].ReplyToAuthor?.DisplayName);

        CursorResponse<CommentReplyItemDto> replies = await queries.GetRepliesAsync(
            42,
            100,
            new CursorPageRequest<long> { Limit = 10 });
        Assert.Equal(["101", "102"], replies.Data.Select(static item => item.Id));
        Assert.True(replies.Data[0].IsDeleted);
        Assert.False(replies.Data[1].IsDeleted);
        Assert.DoesNotContain("middle secret", JsonSerializer.Serialize(replies), StringComparison.Ordinal);
        Assert.DoesNotContain("middle-author", JsonSerializer.Serialize(replies), StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-public-comment-read-deleted-leaf-or-fully-deleted-thread-disappears")]
    public async Task PublicCommentRead_DeletedLeafOrFullyDeletedThread_Disappears()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedPublicComment(db, 100, 42, "root", "root-author");
        SeedPublicComment(db, 101, 42, "leaf secret", "leaf-author", parentId: 100, rootId: 100, replyToCommentId: 100, depth: 1);
        TombstoneComment(db, 101);
        var queries = new CommentQueryService(db, new RegionLegalModerationService());

        CommentThreadItemDto root = Assert.Single((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 },
            previewLimit: 10)).Data);
        Assert.Equal(0, root.ReplyCount);
        Assert.Empty(root.RepliesPreview);
        Assert.Empty((await queries.GetRepliesAsync(
            42,
            100,
            new CursorPageRequest<long> { Limit = 10 })).Data);

        TombstoneComment(db, 100);
        Assert.Empty((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 })).Data);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-public-comment-read-tombstone-chain-uses-viewer-region-visibility")]
    public async Task PublicCommentRead_TombstoneChainUsesViewerRegionVisibility()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedPublicComment(db, 100, 42, "root secret", "root-author");
        SeedPublicComment(db, 101, 42, "region visible child", "child-author", parentId: 100, rootId: 100, replyToCommentId: 100, depth: 1);
        TombstoneComment(db, 100);
        db.Insertable(new CommentBlockedRegion { CommentId = 101, RegionCode = "CN-MAINLAND" }).ExecuteCommand();
        var queries = new CommentQueryService(db, new RegionLegalModerationService());

        Assert.Single((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 },
            viewerRegion: "GLOBAL")).Data);
        Assert.Empty((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 },
            viewerRegion: "CN-MAINLAND")).Data);
        Assert.Empty((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 },
            viewerRegion: "UNKNOWN")).Data);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(3)]
    [InlineData(100)]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task PublicCommentRead_ReplyCountIsExactAndIndependentFromPreviewSize(int replyTotal)
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedPublicComment(db, 100, 42, "root", "root-author");
        if (replyTotal > 0)
        {
            var replies = new List<Comment>(replyTotal);
            for (int index = 0; index < replyTotal; index++)
            {
                long id = 101 + index;
                replies.Add(new Comment
                {
                    Id = id,
                    ArticleId = 42,
                    Content = $"reply-{index}",
                    AuthorMode = CommentAuthorModes.Public,
                    PublicHandle = $"reply-author-{index}",
                    CreateTime = DateTime.UtcNow.AddMinutes(-1),
                    ParentId = 100,
                    RootId = 100,
                    ReplyToCommentId = 100,
                    Depth = 1,
                    IsDeleted = false,
                    ModerationStatus = CommentModerationStatus.Approved
                });
            }

            db.Insertable(replies).ExecuteCommand();
        }

        var queries = new CommentQueryService(db, new RegionLegalModerationService());
        CommentThreadItemDto root = Assert.Single((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 },
            previewLimit: 3)).Data);

        Assert.Equal(replyTotal, root.ReplyCount);
        Assert.Equal(Math.Min(replyTotal, 3), root.RepliesPreview.Count);
        Assert.Equal(replyTotal > 3, root.HasMoreReplies);

        if (replyTotal == 100)
        {
            CursorResponse<CommentReplyItemDto> firstPage = await queries.GetRepliesAsync(
                42,
                100,
                new CursorPageRequest<long> { Limit = 20 });
            Assert.Equal(20, firstPage.Data.Count);
            Assert.True(firstPage.HasMore);
            CursorResponse<CommentReplyItemDto> secondPage = await queries.GetRepliesAsync(
                42,
                100,
                new CursorPageRequest<long>
                {
                    Limit = 20,
                    Cursor = long.Parse(firstPage.NextCursor!, CultureInfo.InvariantCulture)
                });
            Assert.Equal(20, secondPage.Data.Count);
            Assert.DoesNotContain(secondPage.Data, item => firstPage.Data.Any(first => first.Id == item.Id));
        }
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-public-comment-read-article-without-current-publication-has-no-reply-count-projection")]
    public async Task PublicCommentRead_ArticleWithoutCurrentPublicationHasNoReplyCountProjection()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedPublicComment(db, 100, 42, "root", "root-author");
        SeedPublicComment(db, 101, 42, "reply", "reply-author", parentId: 100, rootId: 100, replyToCommentId: 100, depth: 1);
        db.Ado.ExecuteCommand("UPDATE article SET current_publication_id = NULL WHERE id = @ArticleId;", new SugarParameter("@ArticleId", 42));
        var queries = new CommentQueryService(db, new RegionLegalModerationService());

        Assert.Empty((await queries.GetThreadsAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 })).Data);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-attributable-comments-async-returns-only-explicit-public-comments")]
    public async Task GetAttributableCommentsAsync_ReturnsOnlyExplicitPublicComments()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        SeedStrongAnonymousComment(db, commentId: 101, articleId: 42, legacyUserId: 7);
        CommentCommandService service = CreateService(db, new RecordingTicketService());

        var queries = new CommentQueryService(db, new RegionLegalModerationService());
        CursorResponse<UserCommentResponse> result = await queries.GetAttributableAsync(
            7,
            new CursorPageRequest<long> { Limit = 10 });

        UserCommentResponse item = Assert.Single(result.Data);
        Assert.Equal(100, item.Id);
        Assert.Equal("parent", item.Content);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-get-attributable-comments-async-article-overlay-is-account-scoped-and-public-only")]
    public async Task GetAttributableCommentsAsync_ArticleOverlayIsAccountScopedAndPublicOnly()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedArticle(db, articleId: 43);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        SeedApprovedComment(db, commentId: 101, articleId: 42, userId: 8);
        SeedApprovedComment(db, commentId: 102, articleId: 43, userId: 7);
        SeedStrongAnonymousComment(db, commentId: 103, articleId: 42, legacyUserId: 7);
        var queries = new CommentQueryService(db, new RegionLegalModerationService());

        CursorResponse<UserCommentResponse> result = await queries.GetAttributableAsync(
            7,
            new CursorPageRequest<long> { Limit = 100 },
            articleId: 42);

        UserCommentResponse item = Assert.Single(result.Data);
        Assert.Equal(100, item.Id);
        Assert.Equal(42, item.ArticleId);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-delete-comment-async-forged-ownership-cannot-delete-another-accounts-public-comment")]
    public async Task DeleteCommentAsync_ForgedOwnershipCannotDeleteAnotherAccountsPublicComment()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 8);
        CommentCommandService service = CreateService(db, new RecordingTicketService());

        bool deleted = await service.DeleteCommentAsync(100, currentUserId: 7, isAdmin: false);

        Assert.False(deleted);
        Assert.False(db.Queryable<Comment>().InSingle(100).IsDeleted);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-delete-comment-async-account-cannot-delete-strong-anonymous-comment-even-when-legacy-user-id-matches")]
    public async Task DeleteCommentAsync_AccountCannotDeleteStrongAnonymousCommentEvenWhenLegacyUserIdMatches()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedStrongAnonymousComment(db, commentId: 101, articleId: 42, legacyUserId: 7);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentCommandService service = CreateService(db, new RecordingTicketService(), dispatcher: dispatcher);

        bool deleted = await service.DeleteCommentAsync(101, currentUserId: 7, isAdmin: false);

        Assert.False(deleted);
        Comment comment = db.Queryable<Comment>().Single(static item => item.Id == 101);
        Assert.False(comment.IsDeleted);
        Assert.Empty(dispatcher.CommentScopes);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task DeleteCommentAsync_AdminCanDeleteStrongAnonymousCommentWithoutUserCommentInvalidation()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedStrongAnonymousComment(db, commentId: 101, articleId: 42, legacyUserId: 7);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentCommandService service = CreateService(db, new RecordingTicketService(), dispatcher: dispatcher);

        bool deleted = await service.DeleteCommentAsync(101, currentUserId: 1, isAdmin: true);

        Assert.True(deleted);
        Comment comment = db.Queryable<Comment>().Single(static item => item.Id == 101);
        Assert.True(comment.IsDeleted);
        CommentCacheInvalidationScope scope = Assert.Single(dispatcher.CommentScopes)!;
        Assert.Null(scope.AccountId);
        Assert.False(scope.UserCommentsChanged);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-delete-comment-async-repeated-delete-does-not-overwrite-reason-or-repeat-side-effects")]
    public async Task DeleteCommentAsync_RepeatedDeleteDoesNotOverwriteReasonOrRepeatSideEffects()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 101, articleId: 42, userId: 7);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        CommentCommandService service = CreateService(db, new RecordingTicketService(), dispatcher: dispatcher, realtime: realtime);

        bool first = await service.DeleteCommentAsync(101, currentUserId: 7, isAdmin: false, reason: "first-delete");
        bool second = await service.DeleteCommentAsync(101, currentUserId: 7, isAdmin: false, reason: "second-delete");

        Assert.True(first);
        Assert.False(second);
        Comment comment = db.Queryable<Comment>().Single(static item => item.Id == 101);
        Assert.True(comment.IsDeleted);
        Assert.Equal("first-delete", comment.DeleteReason);
        Assert.Equal(CommentModerationStatus.Hidden, comment.ModerationStatus);
        Assert.Single(dispatcher.CommentScopes);
        await realtime.Received(1).PushCommentRemoveAsync(42, 101, 101, null);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void DeleteCommentAsync_RuntimeUsesRowVersionGuardBeforeSideEffects()
    {
        Assert.Equal(typeof(string), typeof(Comment).GetProperty("RowVersion")!.PropertyType);
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentCommandService),
            "DeleteCommentInternalAsync",
            "LoadDeleteCommentRowAsync",
            "TrySoftDeleteCommentAsync");

        Assert.Contains("LoadDeleteCommentRowAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("c.xmin::text AS row_version", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("get_IsDeleted", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TrySoftDeleteCommentAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("InvalidateCommentMutationAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AND is_deleted = false", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Updateable", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task AnonymousCommentCreateEndpoint_DecodesFrameAndReturnsFinalModerationState()
    {
        var aeds = new AedsEncoder();
        var commentService = new CapturingCommentEndpointService();
        DefaultHttpContext context = CreateEndpointContext(
            AedsFrameType.AnonymousCommentCreateRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCommentCreateRequest(CreateRequest(content: "  hello anonymous  "))));

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCommentCreateAsync(
            context,
            commentService,
            new AllowingContentFilter(),
            new FixedClientRegionResolver(),
            new RegionLegalModerationService(),
            new NullRiskSignalSink(),
            FixedZkAnonymousProofService.Available(),
            aeds,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.AnonymousCommentCreateResult, decoded.FrameType);
        using JsonDocument response = JsonDocument.Parse(decoded.Payload);
        Assert.Equal("anonymous-management-secret", response.RootElement.GetProperty("managementSecret").GetString());
        Assert.Equal(123, response.RootElement.GetProperty("commentId").GetInt64());
        Assert.Equal("hello anonymous", commentService.Request.Content);
        Assert.Equal(RegionCodes.Singapore, commentService.RegionDecision!.SubmitRegion);
        Assert.Equal(1, commentService.AnonymousCreateCalls);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task AnonymousCommentCreateEndpoint_UsesRuntimeCommentPolicyLimit()
    {
        var aeds = new AedsEncoder();
        var commentService = new CapturingCommentEndpointService();
        string longContent = new('a', 1200);
        DefaultHttpContext context = CreateEndpointContext(
            AedsFrameType.AnonymousCommentCreateRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCommentCreateRequest(CreateRequest(content: longContent))));

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCommentCreateAsync(
            context,
            commentService,
            new AllowingContentFilter(),
            new FixedClientRegionResolver(),
            new RegionLegalModerationService(),
            new NullRiskSignalSink(),
            FixedZkAnonymousProofService.Available(),
            aeds,
            CancellationToken.None,
            new FixedAnonymousCommentPolicyService(AnonymousCommentPolicySnapshot.Default with
            {
                CommentMaxChars = 1500,
                CommentMaxUtf8Bytes = 6000
            }));

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.AnonymousCommentCreateResult, decoded.FrameType);
        using JsonDocument response = JsonDocument.Parse(decoded.Payload);
        Assert.Equal("anonymous-management-secret", response.RootElement.GetProperty("managementSecret").GetString());
        Assert.Equal(longContent, commentService.Request.Content);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-anonymous-comment-create-endpoint-zk-prod-unavailable-returns-api-error-without-submit")]
    public async Task AnonymousCommentCreateEndpoint_ZkProdUnavailable_ReturnsApiErrorWithoutSubmit()
    {
        var aeds = new AedsEncoder();
        var commentService = new CapturingCommentEndpointService();
        DefaultHttpContext context = CreateEndpointContext(
            AedsFrameType.AnonymousCommentCreateRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeAnonymousCommentCreateRequest(CreateRequest(content: "hello anonymous"))));

        BinaryFrameResult result = await BinaryEndpoints.HandleAnonymousCommentCreateAsync(
            context,
            commentService,
            new AllowingContentFilter(),
            new FixedClientRegionResolver(),
            new RegionLegalModerationService(),
            new NullRiskSignalSink(),
            FixedZkAnonymousProofService.Unavailable("native verifier disabled"),
            aeds,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out ApiErrorPod errorPod));
        Assert.Equal("anonymous_comment_submit_unavailable", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Equal(0, commentService.AnonymousCreateCalls);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task AnonymousCommentCreateEndpoint_IsStrongAnonymousAndDoesNotReplaceSignedEndpoint()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint anonymous = EndpointContractApplication.Find(
            app,
            "/api/binary/comment/anonymous",
            HttpMethods.Post);
        RouteEndpoint signed = EndpointContractApplication.Find(
            app,
            "/api/binary/comment",
            HttpMethods.Post);
        Assert.NotNull(anonymous.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.NotNull(anonymous.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());
        Assert.Null(signed.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.Null(signed.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());

        string anonymousHandler = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.HandleAnonymousCommentCreateAsync));
        Assert.Contains("CreateStrongAnonymousCommentResultAsync", anonymousHandler, StringComparison.Ordinal);
        Assert.Contains("TryDecodeAnonymousCommentCreateRequest", anonymousHandler, StringComparison.Ordinal);

        string signedHandler = RuntimeMetadataInspection.DescribeMethodClosureContaining(
            typeof(BinaryEndpoints),
            "CreateAttributablePublicCommentResultAsync",
            "AccountPrincipalContext");
        Assert.Contains("CreateAttributablePublicCommentResultAsync", signedHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentV2Async", signedHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentAsync", signedHandler, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/api/binary/comment/{id:long}/management/challenge")]
    [InlineData("/api/binary/comment/{id:long}/management/edit")]
    [InlineData("/api/binary/comment/{id:long}/management/delete")]
    [InlineData("/api/binary/comment/{id:long}/management/status")]
    [InlineData("/api/binary/comment/{id:long}/management/appeal")]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task AnonymousCommentManagementEndpoints_RejectIdentifiedPrincipalContamination(string path)
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint endpoint = EndpointContractApplication.Find(app, path, HttpMethods.Post);

        Assert.NotNull(endpoint.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.NotNull(endpoint.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void AnonymousCommentCreateHandler_RuntimeDoesNotBindDefaultAnonymousPathToUserId()
    {
        string anonymousHandler = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.HandleAnonymousCommentCreateAsync));

        Assert.DoesNotContain("GetUserId", anonymousHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("get_UserId", anonymousHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("user_id", anonymousHandler, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("CreateStrongAnonymousCommentResultAsync", anonymousHandler, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task OrdinaryCommentEndpoints_UseAccountPrincipalContextInsteadOfLegacyUserId()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint create = EndpointContractApplication.Find(app, "/api/binary/comment", HttpMethods.Post);
        RouteEndpoint mine = EndpointContractApplication.Find(app, "/api/binary/comment/me", HttpMethods.Get);
        Assert.Null(create.Metadata.GetMetadata<IAllowAnonymous>());
        Assert.Null(mine.Metadata.GetMetadata<IAllowAnonymous>());

        MethodInfo createMethod = Assert.IsAssignableFrom<MethodInfo>(create.Metadata.GetMetadata<MethodInfo>());
        MethodInfo mineMethod = Assert.IsAssignableFrom<MethodInfo>(mine.Metadata.GetMetadata<MethodInfo>());
        string createHandler = RuntimeMetadataInspection.DescribeMethods(createMethod.DeclaringType!, createMethod.Name);
        string myCommentsHandler = RuntimeMetadataInspection.DescribeMethods(mineMethod.DeclaringType!, mineMethod.Name);
        Assert.Contains("CreateAttributablePublicCommentResultAsync", createHandler, StringComparison.Ordinal);
        Assert.Contains("GetUserCommentsAsync", myCommentsHandler, StringComparison.Ordinal);
        Assert.Contains("GetUserCommentsForArticleAsync", myCommentsHandler, StringComparison.Ordinal);
        Assert.Contains("AccountPrincipalContext", createHandler, StringComparison.Ordinal);
        Assert.Contains("AccountPrincipalContext", myCommentsHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId", createHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("GetUserId", myCommentsHandler, StringComparison.Ordinal);
        Assert.Contains("get_AccountId", createHandler, StringComparison.Ordinal);
        Assert.Contains("get_AccountId", myCommentsHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("AuthorAccountId", myCommentsHandler, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void CommentEndpointService_RuntimeContractDoesNotMixUserIdAndIsAdminIdentityPlanes()
    {
        MethodInfo[] methods = typeof(ICommentEndpointService).GetMethods();
        Assert.DoesNotContain(methods, static method => method.Name == "DeleteCommentAsync");
        MethodInfo accountDelete = Assert.Single(methods, static method => method.Name == "DeleteCommentAsAccountAsync");
        MethodInfo adminDelete = Assert.Single(methods, static method => method.Name == "DeleteCommentAsAdminAsync");
        Assert.Contains(accountDelete.GetParameters(), static parameter => parameter.Name == "accountId" && parameter.ParameterType == typeof(int));
        Assert.Contains(adminDelete.GetParameters(), static parameter => parameter.Name == "actor" && parameter.ParameterType == typeof(AdminPrincipalActor));
    }

    private static CommentCommandService CreateService(
        SqlSugarClient db,
        RecordingTicketService ticketService,
        ICommentAnonymousNullifierService? nullifierService = null,
        RecordingCacheInvalidationDispatcher? dispatcher = null,
        IMessageRealtimePublisher? realtime = null)
    {
        nullifierService ??= new RecordingNullifierService();
        dispatcher ??= new RecordingCacheInvalidationDispatcher();
        IConfiguration configuration = BuildConfiguration();
        var policy = new AnonymousCommentPolicyService(configuration);
        IZkAnonymousProofService proofs = FixedZkAnonymousProofService.Available();
        var notifications = new CommentNotificationService(
            realtime ?? Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            NullLogger<CommentNotificationService>.Instance);
        var moderation = new CommentModerationService(
            db,
            new RegionLegalModerationService(),
            dispatcher,
            notifications,
            NullLogger<CommentModerationService>.Instance,
            anonymousPolicy: policy);
        var attribution = new CommentAttributionPrivacyService(
            NullLogger<CommentAttributionPrivacyService>.Instance,
            policy: policy,
            nullifiers: nullifierService,
            tickets: ticketService,
            displayNames: new CommentAnonymousDisplayNameGenerator(),
            configuration: configuration,
            zkProofs: proofs);
        return new CommentCommandService(
            db,
            NullLogger<CommentCommandService>.Instance,
            notifications,
            moderation,
            attribution,
            dispatcher);
    }

    private static IConfiguration BuildConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:Pepper"] = ModerationPepper,
                ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum",
                ["AnonymousIdentity:AnonymousCommentsEnabled"] = "true",
                ["AnonymousIdentity:ZkAnonymousCommentsEnabled"] = "true"
            })
            .Build();

    private static AnonymousCommentCreateRequestCoreModel CreateRequest(
        string content = "anonymous comment",
        string? parentId = null,
        string? rootId = null,
        string? replyToCommentId = null)
        => new(
            42,
            content,
            parentId,
            rootId,
            replyToCommentId,
            rootId is null
                ? AnonymousCommentScopePolicy.CreateTopLevelScope(42)
                : AnonymousCommentScopePolicy.CreateThreadScope(42, long.Parse(rootId, CultureInfo.InvariantCulture)),
            "en",
            [.. s_ticket]);

    private static AnonymousCommentTicketPayload TicketPayload(
        int articleId,
        long? parentId = null,
        long? rootId = null,
        long? replyToCommentId = null,
        long? expiresAtUnixMs = null)
        => new(
            articleId,
            rootId is null
                ? AnonymousCommentScopePolicy.CreateTopLevelScope(articleId)
                : AnonymousCommentScopePolicy.CreateThreadScope(articleId, rootId.Value),
            null,
            rootId,
            null,
            NullifierHash,
            AnonymousPrivacyContract.CommonRateClass,
            false,
            expiresAtUnixMs ?? DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds());

    private static RegionModerationDecision RegionDecision()
        => new(
            true,
            RegionCodes.Singapore,
            0.95d,
            "unit",
            "ip-hash",
            [],
            [],
            [],
            RegionLegalModerationService.CurrentPolicyVersion,
            "allowed",
            "allowed",
            RequiresManualReview: true,
            HideUntilReviewed: true);

    private Task<SqlSugarClient> CreateDbAsync()
        => Task.FromResult(classDatabase.CreateClient());

    public async Task InitializeAsync()
        => _ = await classDatabase.ResetAsync(fixture);

    public Task DisposeAsync() => Task.CompletedTask;

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(Article),
            typeof(ArticlePublicationRecord),
            typeof(Comment),
            typeof(CommentRevision),
            typeof(CommentBlockedRegion),
            typeof(CommentRegionCompliance));
    }

    private static void SeedArticle(SqlSugarClient db, int articleId)
    {
        DateTime publishedAt = DateTime.UtcNow.AddMinutes(-1);
        db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, metadata_updated_at, isdeleted, status,
                 published_at, last_published_at, public_updated_at, scheduled_publish_at)
            VALUES
                (@Id, 'unit article', 1, 0, @PublishedAt, @PublishedAt, false, @Status,
                 @PublishedAt, @PublishedAt, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", publishedAt));
        long publicationId = db.Insertable(new ArticlePublicationRecord
        {
            ArticleId = articleId,
            PublicationNo = 1,
            ArticleRevisionId = 1,
            RevisionNo = 1,
            RightsSnapshotId = 1,
            TransitionKind = "publish",
            PublishedAt = publishedAt,
            CreatedAt = publishedAt
        }).ExecuteReturnBigIdentity();
        db.Ado.ExecuteCommand(
            "UPDATE article SET current_publication_id = @PublicationId WHERE id = @ArticleId;",
            new SugarParameter("@PublicationId", publicationId),
            new SugarParameter("@ArticleId", articleId));
    }

    private static void SeedLegacyUser(
        SqlSugarClient db,
        int userId,
        string username,
        int status = 0,
        DateTime? deletedAt = null)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO sys_user
                (id, public_handle, status, identity_kind, passkey_enabled, recovery_enabled, privacy_initialized_at, deleted_at)
            VALUES
                (@Id, @Username, @Status, 'anonymous_account', true, false, @PrivacyInitializedAt,
                 CAST(@DeletedAt AS timestamp without time zone));
            """,
            new SugarParameter("@Id", userId),
            new SugarParameter("@Username", username),
            new SugarParameter("@Status", status),
            new SugarParameter("@PrivacyInitializedAt", DateTime.UtcNow),
            new SugarParameter("@DeletedAt", deletedAt));

    private static void SeedApprovedComment(SqlSugarClient db, long commentId, int articleId, int? userId)
        => db.Insertable(new Comment
        {
            Id = commentId,
            ArticleId = articleId,
            Content = "parent",
            UserId = userId,
            AuthorMode = CommentAuthorModes.Public,
            PublicHandle = "parent-user",
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            ParentId = null,
            RootId = null,
            ReplyToUserId = null,
            ReplyToCommentId = null,
            Depth = 0,
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommand();

    private static void SeedVisibleComment(
        SqlSugarClient db,
        long commentId,
        int articleId,
        int? userId,
        string content,
        string authorMode,
        string? publicHandle,
        string? anonymousDisplayName,
        string? anonymousDisplayLanguage,
        string? anonymousScope,
        string? credentialLevel,
        long? parentId = null,
        long? rootId = null,
        long? replyToCommentId = null,
        int? replyToUserId = null,
        int depth = 0)
        => db.Insertable(new Comment
        {
            Id = commentId,
            ArticleId = articleId,
            Content = content,
            UserId = userId,
            AuthorMode = authorMode,
            PublicHandle = publicHandle,
            AnonymousDisplayName = anonymousDisplayName,
            AnonymousDisplayLanguage = anonymousDisplayLanguage,
            AnonymousScope = anonymousScope,
            CredentialLevel = credentialLevel,
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            ParentId = parentId,
            RootId = rootId,
            ReplyToUserId = replyToUserId,
            ReplyToCommentId = replyToCommentId,
            Depth = depth,
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommand();

    private static void SeedPublicComment(
        SqlSugarClient db,
        long commentId,
        int articleId,
        string content,
        string publicHandle,
        long? parentId = null,
        long? rootId = null,
        long? replyToCommentId = null,
        int depth = 0)
        => SeedVisibleComment(
            db,
            commentId,
            articleId,
            null,
            content,
            CommentAuthorModes.Public,
            publicHandle,
            null,
            null,
            null,
            null,
            parentId,
            rootId,
            replyToCommentId,
            depth: depth);

    private static void TombstoneComment(SqlSugarClient db, long commentId)
        => db.Updateable<Comment>()
            .SetColumns(static item => item.IsDeleted == true)
            .SetColumns(static item => item.ModerationStatus == CommentModerationStatus.Hidden)
            .Where(item => item.Id == commentId)
            .ExecuteCommand();

    private static void SeedStrongAnonymousComment(SqlSugarClient db, long commentId, int articleId, int? legacyUserId)
        => db.Insertable(new Comment
        {
            Id = commentId,
            ArticleId = articleId,
            Content = "strong anonymous",
            UserId = legacyUserId,
            AuthorMode = CommentAuthorModes.ZkAnonymous,
            AnonymousHandle = "anon-legacy",
            AnonymousDisplayName = "Anonymous User Alex",
            AnonymousDisplayLanguage = "en",
            AnonymousNullifierHash = $"{commentId:x64}",
            AnonymousScope = $"article:{articleId}",
            ModerationSubjectHash = $"moderation-{commentId}",
            CredentialLevel = AnonymousCredentialLevels.StrongAnonymous,
            ReputationBucket = "rep-low",
            AccountAgeBucket = "credential_bound",
            CreateTime = DateTime.UtcNow.AddMinutes(-1),
            ParentId = null,
            RootId = null,
            ReplyToUserId = null,
            ReplyToCommentId = null,
            Depth = 0,
            IsDeleted = false,
            ModerationStatus = CommentModerationStatus.Approved
        }).ExecuteCommand();

    private static DefaultHttpContext CreateEndpointContext(AedsFrameType expectedFrameType, BinaryRequestPayload payload)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/comment/anonymous";
        context.Request.Headers.Accept = "application/octet-stream";
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(new FakeBinaryEndpointRequestContext(expectedFrameType, payload))
            .BuildServiceProvider();
        return context;
    }

    private static async Task<AedsDecodeResult> ExecuteAndDecodeAsync(BinaryFrameResult result, DefaultHttpContext context, AedsEncoder aeds)
    {
        await result.ExecuteAsync(context);
        byte[] frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed class RecordingTicketService(Func<Task>? onConsumeAsync = null) : IAnonymousCommentTicketService
    {
        private readonly Dictionary<string, AnonymousCommentTicketPayload> _payloads = new(StringComparer.Ordinal);

        public int ConsumeAttempts
        {
            get; private set;
        }

        public void Add(byte[] ticket, AnonymousCommentTicketPayload payload)
            => _payloads[AnonymousCommentTicketService.HashTicket(ticket)] = payload;

        public Task<AnonymousCommentTicketIssueResult> IssueAsync(AnonymousCommentTicketRequestCoreModel request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public async Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(byte[] ticket, CancellationToken cancellationToken = default)
        {
            ConsumeAttempts++;
            string hash = AnonymousCommentTicketService.HashTicket(ticket);
            if (!_payloads.Remove(hash, out AnonymousCommentTicketPayload? payload))
            {
                return new CacheReadResult<AnonymousCommentTicketPayload>(false, default);
            }

            if (onConsumeAsync is not null)
            {
                await onConsumeAsync();
            }

            return new CacheReadResult<AnonymousCommentTicketPayload>(true, payload);
        }
    }

    private sealed class RecordingNullifierService : ICommentAnonymousNullifierService
    {
        public List<(string NullifierHash, string Scope)> Reservations { get; } = [];

        public List<(string NullifierHash, string Scope, long CommentId)> Increments { get; } = [];

        public List<(string NullifierHash, string Scope, long CommentId)> Consumes { get; } = [];

        public Task<NullifierReservationResult> PrecheckAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
            => Task.FromResult(new NullifierReservationResult(true, "prechecked", "prechecked", 0));

        public Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Reservations.Add((nullifierHash, scope));
            return Task.FromResult(new NullifierReservationResult(true, "reserved", "reserved", 0));
        }

        public Task<NullifierReservationResult> TryConsumeAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
        {
            Consumes.Add((nullifierHash, scope, commentId));
            return Task.FromResult(new NullifierReservationResult(true, "reserved", "reserved", 1));
        }

        public Task<bool> IncrementUsageAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
        {
            Increments.Add((nullifierHash, scope, commentId));
            return Task.FromResult(true);
        }

        public Task<bool> BlockAsync(string nullifierHash, string scope, string reason, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class RecordingCacheInvalidationDispatcher : ICacheInvalidationDispatcher
    {
        public List<CommentCacheInvalidationScope?> CommentScopes { get; } = [];

        public Task InvalidateArticleMutationAsync(int? articleId = null, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSeoAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateComplianceAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateSystemPageAsync(string slug, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCategoryTagAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateCommentPolicyAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task InvalidateCommentMutationAsync(CommentCacheInvalidationScope? scope = null, CancellationToken cancellationToken = default)
        {
            CommentScopes.Add(scope);
            return Task.CompletedTask;
        }

        public Task InvalidateStatsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateArticleViewAsync(int articleId, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task InvalidateHotArticlesAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class CapturingCommentEndpointService : ICommentEndpointService
    {
        public AnonymousCommentCreateRequestCoreModel Request
        {
            get; private set;
        }

        public RegionModerationDecision? RegionDecision
        {
            get; private set;
        }

        public int AnonymousCreateCalls
        {
            get; private set;
        }

        public Task<bool> CreateStrongAnonymousCommentAsync(
            AnonymousCommentCreateRequestCoreModel request,
            RegionModerationDecision? regionDecision = null,
            CancellationToken cancellationToken = default)
        {
            AnonymousCreateCalls++;
            Request = request;
            RegionDecision = regionDecision;
            return Task.FromResult(true);
        }

        public Task<CommentCreateResult> CreateStrongAnonymousCommentResultAsync(
            AnonymousCommentCreateRequestCoreModel request,
            RegionModerationDecision? regionDecision = null,
            CancellationToken cancellationToken = default)
        {
            AnonymousCreateCalls++;
            Request = request;
            RegionDecision = regionDecision;
            return Task.FromResult(new CommentCreateResult(
                true,
                123,
                123,
                null,
                new DateTime(2026, 7, 20, 1, 20, 0, DateTimeKind.Utc),
                CommentModerationStatus.Pending,
                "pending",
                false,
                false,
                ManagementSecret: "anonymous-management-secret"));
        }

        public Task<bool> CreateCommentAsync(int userId, CommentDto dto) => throw new NotSupportedException();
        public Task<bool> CreateAttributablePublicCommentAsync(AccountPrincipalContext account, CommentCreateRequestCoreModel request, RegionModerationDecision? regionDecision = null) => throw new NotSupportedException();
        public Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(int articleId, CursorPageRequest<long> request, int previewLimit = 3, string viewerRegion = "GLOBAL") => throw new NotSupportedException();
        public Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request, string viewerRegion = "GLOBAL") => throw new NotSupportedException();
        public Task<bool> DeleteCommentAsAccountAsync(long id, int accountId, string reason = "违反社区管理条例") => throw new NotSupportedException();
        public Task<bool> DeleteCommentAsAdminAsync(long id, AdminPrincipalActor actor, string reason = "违反社区管理条例") => throw new NotSupportedException();
    }

    private sealed class AllowingContentFilter : IContentFilterService
    {
        public ContentValidationResult ValidateContent(string text)
            => new(true, "ok", "ok");

        public void ReloadKeywords()
        {
        }
    }

    private sealed class FixedClientRegionResolver : IClientRegionResolver
    {
        public ClientRegionResolution Resolve(HttpContext httpContext)
            => new(RegionCodes.Singapore, "unit", 0.95d, "198.51.100.17", "ip-hash");
    }

    private sealed class NullRiskSignalSink : ISecurityRiskSignalSink
    {
        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;
    }

    private sealed class FixedAnonymousCommentPolicyService(AnonymousCommentPolicySnapshot snapshot) : IAnonymousCommentPolicyService
    {
        public AnonymousCommentPolicySnapshot Current => snapshot;

        public Task<AnonymousCommentPolicySnapshot> GetCurrentAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public AnonymousCommentPolicySnapshot UpdatePolicy(AnonymousCommentPolicyUpdateRequest request, long? adminPrincipalId = null)
            => snapshot;

        public Task<AnonymousCommentPolicySnapshot> UpdatePolicyAsync(
            AnonymousCommentPolicyUpdateRequest request,
            long? adminPrincipalId = null,
            CancellationToken cancellationToken = default)
            => Task.FromResult(snapshot);

        public CommentAuthorModeDecision EvaluateAuthorMode(string? requestedAuthorMode, bool publicSendExplicitlySelected)
            => CommentAuthorModeDecision.Allow(requestedAuthorMode ?? snapshot.DefaultAuthorMode);

        public Task<CommentAuthorModeDecision> EvaluateAuthorModeAsync(
            string? requestedAuthorMode,
            bool publicSendExplicitlySelected,
            CancellationToken cancellationToken = default)
            => Task.FromResult(EvaluateAuthorMode(requestedAuthorMode, publicSendExplicitlySelected));
    }

    private sealed class FakeBinaryEndpointRequestContext(AedsFrameType expectedFrameType, BinaryRequestPayload payload) : IBinaryEndpointRequestContext
    {
        public Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expected, CancellationToken cancellationToken, int? maxFrameBytes = null)
        {
            Assert.Equal(expectedFrameType, expected);
            return Task.FromResult(payload);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(HttpContext httpContext, IAedsEncoder aeds, IReadOnlyCollection<AedsFrameType> expected, CancellationToken cancellationToken, int? maxFrameBytes = null)
        {
            Assert.Contains(expectedFrameType, expected);
            return Task.FromResult(payload);
        }

        public Task<NameMutationPayload> ReadNameMutationAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expectedFrameType, CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public string BuildArticleViewerIdentity(HttpContext context, int articleId) => $"article:{articleId}:viewer:test";
        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache) => ValueTask.FromResult(0L);
        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "") => "article-list";
        public string BuildArticleHotCacheIdentity(int count) => $"hot:{count}";
        public string? GetDeviceFingerprint(HttpContext context) => null;
        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }

    private sealed class FixedZkAnonymousProofService(ZkCommentPolicySnapshot policy) : IZkAnonymousProofService
    {
        public AnonymousCommentPolicySnapshot CurrentCommentPolicy
        {
            get;
        } = AnonymousCommentPolicySnapshot.Default with
        {
            ZkAnonymousEnabled = true
        };

        public ZkAnonymousPolicySnapshot CurrentZkPolicy { get; } = new(true, true, "comment.create", []);

        public ZkCommentPolicySnapshot CurrentZkCommentPolicy { get; } = policy;

        public static FixedZkAnonymousProofService Available()
            => new(new ZkCommentPolicySnapshot(
                Enabled: true,
                NativeVerifierConfigured: true,
                TrustedSetupVerified: true,
                CredentialRequired: true,
                CredentialRootReady: true,
                UnavailableReason: string.Empty));

        public static FixedZkAnonymousProofService Unavailable(string reason)
            => new(new ZkCommentPolicySnapshot(
                Enabled: true,
                NativeVerifierConfigured: false,
                TrustedSetupVerified: true,
                CredentialRequired: true,
                CredentialRootReady: true,
                UnavailableReason: reason));

        public Task<ZkProofVerificationResult> VerifyCommentProofAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(ZkProofVerificationResult.VerifierUnavailable());
    }
}
