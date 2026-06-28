using System.Net;
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
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollection))]
public sealed class AnonymousCommentSubmitTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly byte[] Ticket = Enumerable.Range(0, 32).Select(static value => (byte)(value + 1)).ToArray();
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string ModerationPepper = "unit-test-moderation-pepper-with-at-least-thirty-two-chars";

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_ValidTicket_WritesPendingAnonymousCommentGovernanceFieldsAndInvalidatesScope()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42));
        var nullifiers = new RecordingNullifierService();
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentService service = CreateService(db, tickets, nullifiers, dispatcher);

        bool created = await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.True(created);
        Comment comment = Assert.Single(db.Queryable<Comment>().ToList());
        Assert.Null(comment.UserId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, comment.AuthorMode);
        Assert.Equal(NullifierHash, comment.AnonymousNullifierHash);
        Assert.Equal("article:42", comment.AnonymousScope);
        Assert.Equal("strong_anonymous", comment.CredentialLevel);
        Assert.Equal("rep-low", comment.ReputationBucket);
        Assert.Equal("credential_bound", comment.AccountAgeBucket);
        Assert.Equal(
            Convert.ToHexStringLower(HMACSHA256.HashData(
                Encoding.UTF8.GetBytes(ModerationPepper),
                Encoding.UTF8.GetBytes(NullifierHash))),
            comment.ModerationSubjectHash);
        Assert.Equal(CommentModerationStatus.Pending, comment.ModerationStatus);
        Assert.DoesNotContain(Convert.ToHexString(Ticket), comment.Content, StringComparison.OrdinalIgnoreCase);

        CommentRegionCompliance compliance = Assert.Single(db.Queryable<CommentRegionCompliance>().ToList());
        Assert.Equal(comment.Id, compliance.CommentId);
        Assert.Equal(RegionCodes.Singapore, compliance.SubmitRegion);
        Assert.True(compliance.CanPublish);

        var increment = Assert.Single(nullifiers.Increments);
        Assert.Equal(NullifierHash, increment.NullifierHash);
        Assert.Equal("article:42", increment.Scope);
        Assert.Equal(comment.Id, increment.CommentId);

        CommentCacheInvalidationScope scope = Assert.Single(dispatcher.CommentScopes)!;
        Assert.Equal(42, scope.ArticleId);
        Assert.Equal(comment.Id, scope.RootId);
        Assert.Null(scope.AccountId);
        Assert.False(scope.PublicArticleChanged);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_ReplayedTicket_IsRejectedBeforeSecondWrite()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42));
        CommentService service = CreateService(db, tickets);

        Assert.True(await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None));
        Assert.False(await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None));

        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Equal(2, tickets.ConsumeAttempts);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_ExpiredTicket_IsRejectedWithoutCommentOrUsageIncrement()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, expiresAtUnixMs: DateTimeOffset.UtcNow.AddSeconds(-1).ToUnixTimeMilliseconds()));
        var nullifiers = new RecordingNullifierService();
        CommentService service = CreateService(db, tickets, nullifiers);

        bool created = await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Empty(nullifiers.Increments);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_TicketReplyContextMismatch_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentService service = CreateService(db, tickets);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "101", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, db.Queryable<Comment>().Count());
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_ValidReply_UsesServerSideReplyProjectionWithoutReplyUserId()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentService service = CreateService(db, tickets);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.True(created);
        Comment reply = db.Queryable<Comment>().OrderBy(static item => item.Id, OrderByType.Desc).First();
        Assert.Null(reply.UserId);
        Assert.Equal(100, reply.ParentId);
        Assert.Equal(100, reply.RootId);
        Assert.Equal(100, reply.ReplyToCommentId);
        Assert.Null(reply.ReplyToUserId);
        Assert.Equal(1, reply.Depth);

        await db.Updateable<Comment>()
            .SetColumns(static item => item.ModerationStatus == CommentModerationStatus.Approved)
            .Where(item => item.Id == reply.Id)
            .ExecuteCommandAsync();

        CursorResponse<CommentReplyItemDto> replies = await service.GetThreadRepliesByCursorAsync(
            42,
            100,
            new CursorPageRequest<long> { Limit = 5 });
        CommentReplyItemDto visibleReply = Assert.Single(replies.Data);
        Assert.Equal(CommentAuthorModes.Public, visibleReply.ReplyToAuthor?.Mode);
        Assert.Equal("parent-user", visibleReply.ReplyToAuthor?.DisplayName);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_ArticleDeletedAfterPrecheck_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42));
        var nullifiers = new MutatingNullifierService(() => db.Ado.ExecuteCommandAsync(
            """
            UPDATE article
            SET isdeleted = true
            WHERE id = @ArticleId;
            """,
            new SugarParameter("@ArticleId", 42)));
        CommentService service = CreateService(db, tickets, nullifiers);

        bool created = await service.CreateStrongAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.False(db.Queryable<Article>().InSingle(42).IsDeleted);
        Assert.Empty(nullifiers.Increments);
    }

    [Fact]
    public async Task CreateStrongAnonymousCommentAsync_ParentHiddenAfterPrecheck_IsRejected()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        var nullifiers = new MutatingNullifierService(() => db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment
            SET moderation_status = @HiddenStatus
            WHERE id = @ParentId;
            """,
            new SugarParameter("@HiddenStatus", (int)CommentModerationStatus.Hidden),
            new SugarParameter("@ParentId", 100L)));
        CommentService service = CreateService(db, tickets, nullifiers);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateStrongAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Equal(CommentModerationStatus.Approved, db.Queryable<Comment>().InSingle(100).ModerationStatus);
        Assert.Empty(nullifiers.Increments);
    }

    [Fact]
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
        CommentService service = CreateService(db, new RecordingTicketService());

        CursorResponse<CommentThreadItemDto> result = await service.GetCommentThreadsByCursorAsync(
            42,
            new CursorPageRequest<long> { Limit = 10 });

        CommentThreadItemDto item = Assert.Single(result.Data);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, item.Author.Mode);
        Assert.Equal("匿名用户", item.Author.DisplayName);
        Assert.DoesNotContain("legacy_real_name", JsonSerializer.Serialize(item), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
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
        CommentService service = CreateService(db, new RecordingTicketService());

        CursorResponse<CommentReplyItemDto> result = await service.GetThreadRepliesByCursorAsync(
            42,
            100,
            new CursorPageRequest<long> { Limit = 10 });

        CommentReplyItemDto reply = Assert.Single(result.Data);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, reply.ReplyToAuthor?.Mode);
        Assert.Equal("匿名用户", reply.ReplyToAuthor?.DisplayName);
        Assert.DoesNotContain("legacy_real_name", JsonSerializer.Serialize(reply), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task GetAttributableCommentsAsync_ReturnsOnlyExplicitPublicComments()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        SeedStrongAnonymousComment(db, commentId: 101, articleId: 42, legacyUserId: 7);
        CommentService service = CreateService(db, new RecordingTicketService());

        CursorResponse<UserCommentResponse> result = await service.GetAttributableCommentsAsync(
            7,
            new CursorPageRequest<long> { Limit = 10 });

        UserCommentResponse item = Assert.Single(result.Data);
        Assert.Equal(100, item.Id);
        Assert.Equal("parent", item.Content);
    }

    [Fact]
    public async Task DeleteCommentAsync_AccountCannotDeleteStrongAnonymousCommentEvenWhenLegacyUserIdMatches()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedStrongAnonymousComment(db, commentId: 101, articleId: 42, legacyUserId: 7);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentService service = CreateService(db, new RecordingTicketService(), dispatcher: dispatcher);

        bool deleted = await service.DeleteCommentAsync(101, currentUserId: 7, isAdmin: false);

        Assert.False(deleted);
        Comment comment = db.Queryable<Comment>().Single(static item => item.Id == 101);
        Assert.False(comment.IsDeleted);
        Assert.Empty(dispatcher.CommentScopes);
    }

    [Fact]
    public async Task DeleteCommentAsync_AdminCanDeleteStrongAnonymousCommentWithoutUserCommentInvalidation()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedStrongAnonymousComment(db, commentId: 101, articleId: 42, legacyUserId: 7);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentService service = CreateService(db, new RecordingTicketService(), dispatcher: dispatcher);

        bool deleted = await service.DeleteCommentAsync(101, currentUserId: 1, isAdmin: true);

        Assert.True(deleted);
        Comment comment = db.Queryable<Comment>().Single(static item => item.Id == 101);
        Assert.True(comment.IsDeleted);
        CommentCacheInvalidationScope scope = Assert.Single(dispatcher.CommentScopes)!;
        Assert.Null(scope.AccountId);
        Assert.False(scope.UserCommentsChanged);
    }

    [Fact]
    public async Task DeleteCommentAsync_RepeatedDeleteDoesNotOverwriteReasonOrRepeatSideEffects()
    {
        using SqlSugarClient db = await CreateDbAsync();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 101, articleId: 42, userId: 7);
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        IMessageRealtimePublisher realtime = Substitute.For<IMessageRealtimePublisher>();
        CommentService service = CreateService(db, new RecordingTicketService(), dispatcher: dispatcher, realtime: realtime);

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
    public void DeleteCommentAsync_SourceUsesRowVersionGuardBeforeSideEffects()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/CommentService.cs");
        string entity = BackendTestPaths.ReadAllTextFromRoot("src/backend/Entities/Comment.cs");
        string deleteBlock = ExtractBetween(
            source,
            "private async Task<bool> DeleteCommentInternalAsync",
            "private async Task<DeleteCommentRow?> LoadDeleteCommentRowAsync");
        string loadBlock = ExtractBetween(
            source,
            "private async Task<DeleteCommentRow?> LoadDeleteCommentRowAsync",
            "private async Task<bool> TrySoftDeleteCommentAsync");
        string updateBlock = ExtractBetween(
            source,
            "private async Task<bool> TrySoftDeleteCommentAsync",
            "private async Task<List<ThreadRootRow>> QueryThreadRootsAsync");

        Assert.Contains("public string? RowVersion", entity, StringComparison.Ordinal);
        Assert.Contains("LoadDeleteCommentRowAsync(id)", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("c.xmin::text AS row_version", loadBlock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("row.IsDeleted", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("TrySoftDeleteCommentAsync(row.Id, row.RowVersion", deleteBlock, StringComparison.Ordinal);
        Assert.Contains("if (!deleted)", deleteBlock, StringComparison.Ordinal);
        Assert.True(
            deleteBlock.IndexOf("if (!deleted)", StringComparison.Ordinal) <
            deleteBlock.IndexOf("InvalidateCommentMutationAsync", StringComparison.Ordinal));
        Assert.Contains("AND is_deleted = false", updateBlock, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", updateBlock, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Updateable<Comment>()", deleteBlock, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnonymousCommentCreateEndpoint_DecodesFrameAndReturnsEmptySuccess()
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
        Assert.Equal(AedsFrameType.EmptySuccess, decoded.FrameType);
        Assert.Equal("hello anonymous", commentService.Request.Content);
        Assert.Equal(RegionCodes.Singapore, commentService.RegionDecision!.SubmitRegion);
        Assert.Equal(1, commentService.AnonymousCreateCalls);
    }

    [Fact]
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
    public void AnonymousCommentCreateEndpoint_IsStrongAnonymousAndDoesNotReplaceSignedEndpoint()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string anonymousHandler = ExtractBetween(
            source,
            "group.MapPost(\"/comment/anonymous\"",
            "group.MapPost(\"/comment\"");
        string signedHandler = ExtractBetween(
            source,
            "group.MapPost(\"/comment\"",
            "group.MapGet(\"/comment/{articleId:int}\"");

        Assert.Contains(".AllowAnonymous()", anonymousHandler, StringComparison.Ordinal);
        Assert.Contains(".RequireStrongAnonymousRequest()", anonymousHandler, StringComparison.Ordinal);
        Assert.Contains("HandleAnonymousCommentCreateAsync", anonymousHandler, StringComparison.Ordinal);
        Assert.Contains("AedsFrameType.AnonymousCommentCreateRequest", source, StringComparison.Ordinal);
        Assert.Contains("CreateStrongAnonymousCommentAsync", source, StringComparison.Ordinal);

        Assert.Contains(".RequireAnonymousAccountPrincipal()", signedHandler, StringComparison.Ordinal);
        Assert.Contains("[AedsFrameType.CommentCreateV2Request]", signedHandler, StringComparison.Ordinal);
        Assert.Contains("CreateAttributablePublicCommentAsync", signedHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("AedsFrameType.CommentCreate" + "Request", signedHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentAsync(userId", signedHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("CreateCommentV2Async", signedHandler, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousCommentCreateHandler_DoesNotBindDefaultAnonymousPathToUserId()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string anonymousHandler = ExtractBetween(
            source,
            "internal static async Task<BinaryFrameResult> HandleAnonymousCommentCreateAsync",
            "private static bool IsCommentContentWithinLimit");

        Assert.DoesNotContain("GetUserId", anonymousHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", anonymousHandler, StringComparison.Ordinal);
        Assert.DoesNotContain("user_id", anonymousHandler, StringComparison.Ordinal);
        Assert.Contains("CreateStrongAnonymousCommentAsync", anonymousHandler, StringComparison.Ordinal);
    }

    [Fact]
    public void OrdinaryCommentEndpoints_UseAccountPrincipalContextInsteadOfLegacyUserId()
    {
        string source = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");
        string createHandler = ExtractBetween(
            source,
            "group.MapPost(\"/comment\"",
            "group.MapGet(\"/comment/{articleId:int}\"");
        string myCommentsHandler = ExtractBetween(
            source,
            "group.MapGet(\"/comment/me\"",
            "group.MapDelete(\"/comment/{id:long}\"");

        Assert.DoesNotContain("GetUserId", source, StringComparison.Ordinal);
        Assert.Contains("AccountPrincipalContext account", createHandler, StringComparison.Ordinal);
        Assert.Contains("AccountPrincipalContext account", myCommentsHandler, StringComparison.Ordinal);
        Assert.Contains(".RequireAnonymousAccountPrincipal()", createHandler, StringComparison.Ordinal);
        Assert.Contains(".RequireAnonymousAccountPrincipal()", myCommentsHandler, StringComparison.Ordinal);
        Assert.Contains("account.AccountId", createHandler, StringComparison.Ordinal);
        Assert.Contains("account.AccountId", myCommentsHandler, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentEndpointService_DoesNotMixUserIdAndIsAdminIdentityPlanes()
    {
        string service = BackendTestPaths.ReadAllTextFromRoot("src/backend/Interfaces/ICommentEndpointService.cs");
        string endpoints = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Comments.cs");

        Assert.DoesNotContain("DeleteCommentAsync(long id, int currentUserId, bool isAdmin", service, StringComparison.Ordinal);
        Assert.Contains("DeleteCommentAsAccountAsync(long id, int accountId", service, StringComparison.Ordinal);
        Assert.Contains("DeleteCommentAsAdminAsync(long id, AdminPrincipalActor actor", service, StringComparison.Ordinal);
        Assert.Contains("AdminPrincipalActor", endpoints, StringComparison.Ordinal);
    }

    private static CommentService CreateService(
        SqlSugarClient db,
        RecordingTicketService ticketService,
        ICommentAnonymousNullifierService? nullifierService = null,
        RecordingCacheInvalidationDispatcher? dispatcher = null,
        IMessageRealtimePublisher? realtime = null)
    {
        nullifierService ??= new RecordingNullifierService();
        dispatcher ??= new RecordingCacheInvalidationDispatcher();
        return new CommentService(
            db,
            NullLogger<CommentService>.Instance,
            realtime ?? Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            dispatcher,
            new RegionLegalModerationService(),
            anonymousNullifierService: nullifierService,
            anonymousCommentTicketService: ticketService,
            anonymousDisplayNameGenerator: new CommentAnonymousDisplayNameGenerator(),
            configuration: BuildConfiguration());
    }

    private static IConfiguration BuildConfiguration()
        => new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Moderation:Pepper"] = ModerationPepper,
                ["AnonymousIdentity:NullifierPepper"] = "unit-test-anonymous-nullifier-pepper-32-bytes-minimum"
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
            20260619,
            "article:42",
            "en",
            [.. Ticket]);

    private static AnonymousCommentTicketPayload TicketPayload(
        int articleId,
        long? parentId = null,
        long? rootId = null,
        long? replyToCommentId = null,
        long? expiresAtUnixMs = null)
        => new(
            articleId,
            $"article:{articleId}",
            parentId,
            rootId,
            replyToCommentId,
            NullifierHash,
            20260619,
            "strong_anonymous",
            "rep-low",
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
        => PostgresSqlSugarTestClient.CreateAsync(fixture);

    private static void CreateTables(SqlSugarClient db)
    {
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(User),
            typeof(Article),
            typeof(Comment),
            typeof(CommentBlockedRegion),
            typeof(CommentRegionCompliance));
    }

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article
                (id, title, categoryid, views, createtime, isdeleted, status, published_at, scheduled_publish_at)
            VALUES
                (@Id, 'unit article', 1, 0, @PublishedAt, false, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

    private static void SeedLegacyUser(SqlSugarClient db, int userId, string username)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO sys_user
                (id, public_handle, status, identity_kind, passkey_enabled, recovery_enabled, privacy_initialized_at)
            VALUES
                (@Id, @Username, 0, 'anonymous_account', true, false, @PrivacyInitializedAt);
            """,
            new SugarParameter("@Id", userId),
            new SugarParameter("@Username", username),
            new SugarParameter("@PrivacyInitializedAt", DateTime.UtcNow));

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

    private static string ExtractBetween(string source, string start, string end)
    {
        int startIndex = source.IndexOf(start, StringComparison.Ordinal);
        Assert.True(startIndex >= 0, $"Missing start marker: {start}");
        int endIndex = source.IndexOf(end, startIndex + start.Length, StringComparison.Ordinal);
        Assert.True(endIndex > startIndex, $"Missing end marker: {end}");
        return source[startIndex..endIndex];
    }

    private sealed class RecordingTicketService : IAnonymousCommentTicketService
    {
        private readonly Dictionary<string, AnonymousCommentTicketPayload> _payloads = new(StringComparer.Ordinal);

        public int ConsumeAttempts { get; private set; }

        public void Add(byte[] ticket, AnonymousCommentTicketPayload payload)
            => _payloads[AnonymousCommentTicketService.HashTicket(ticket)] = payload;

        public Task<AnonymousCommentTicketIssueResult> IssueAsync(AnonymousCommentTicketRequestCoreModel request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<AnonymousCommentTicketPayload>> ConsumeTicketAsync(byte[] ticket, CancellationToken cancellationToken = default)
        {
            ConsumeAttempts++;
            string hash = AnonymousCommentTicketService.HashTicket(ticket);
            return Task.FromResult(_payloads.Remove(hash, out AnonymousCommentTicketPayload? payload)
                ? new CacheReadResult<AnonymousCommentTicketPayload>(true, payload)
                : new CacheReadResult<AnonymousCommentTicketPayload>(false, default));
        }
    }

    private sealed class RecordingNullifierService : ICommentAnonymousNullifierService
    {
        public List<(string NullifierHash, string Scope)> Reservations { get; } = [];

        public List<(string NullifierHash, string Scope, long CommentId)> Increments { get; } = [];

        public Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            Reservations.Add((nullifierHash, scope));
            return Task.FromResult(new NullifierReservationResult(true, "reserved", "reserved", 0));
        }

        public Task<bool> IncrementUsageAsync(string nullifierHash, string scope, long commentId, CancellationToken cancellationToken = default)
        {
            Increments.Add((nullifierHash, scope, commentId));
            return Task.FromResult(true);
        }

        public Task<bool> BlockAsync(string nullifierHash, string scope, string reason, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class MutatingNullifierService(Func<Task> mutateAsync) : ICommentAnonymousNullifierService
    {
        private bool _mutated;

        public List<(string NullifierHash, string Scope, long CommentId)> Increments { get; } = [];

        public async Task<NullifierReservationResult> CheckAndReserveAsync(string nullifierHash, string scope, CancellationToken cancellationToken = default)
        {
            if (!_mutated)
            {
                _mutated = true;
                await mutateAsync();
            }

            return new NullifierReservationResult(true, "reserved", "reserved", 0);
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
        public AnonymousCommentCreateRequestCoreModel Request { get; private set; }

        public RegionModerationDecision? RegionDecision { get; private set; }

        public int AnonymousCreateCalls { get; private set; }

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

        public Task<bool> CreateCommentAsync(int userId, CommentDto dto) => throw new NotSupportedException();
        public Task<bool> CreateAttributablePublicCommentAsync(AccountPrincipalContext account, CommentCreateV2RequestCoreModel request, RegionModerationDecision? regionDecision = null) => throw new NotSupportedException();
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
        public ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache) => ValueTask.FromResult(0L);
        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "") => "article-list";
        public string BuildArticleHotCacheIdentity(int count) => $"hot:{count}";
        public string? GetDeviceFingerprint(HttpContext context) => null;
        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }

    private sealed class FixedZkAnonymousProofService(ZkProdPolicySnapshot policy) : IZkAnonymousProofService
    {
        public AnonymousCommentPolicySnapshot CurrentCommentPolicy { get; } = AnonymousCommentPolicySnapshot.Default with
        {
            ZkAnonymousEnabled = true
        };

        public ZkAnonymousPolicySnapshot CurrentZkPolicy { get; } = new(true, true, "comment.create", []);

        public ZkProdPolicySnapshot CurrentZkProdPolicy { get; } = policy;

        public static FixedZkAnonymousProofService Available()
            => new(new ZkProdPolicySnapshot(
                Enabled: true,
                NativeVerifierConfigured: true,
                TrustedSetupVerified: true,
                CredentialRequired: true,
                CredentialRootReady: true,
                UnavailableReason: string.Empty));

        public static FixedZkAnonymousProofService Unavailable(string reason)
            => new(new ZkProdPolicySnapshot(
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
