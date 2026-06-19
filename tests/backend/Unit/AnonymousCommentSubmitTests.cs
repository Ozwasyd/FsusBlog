using System.Net;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Entities;
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
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentSubmitTests
{
    private static readonly byte[] Ticket = Enumerable.Range(0, 32).Select(static value => (byte)(value + 1)).ToArray();
    private const string NullifierHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task CreateAnonymousCommentAsync_ValidTicket_WritesPendingAnonymousCommentGovernanceFieldsAndInvalidatesScope()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42));
        var nullifiers = new RecordingNullifierService();
        var dispatcher = new RecordingCacheInvalidationDispatcher();
        CommentService service = CreateService(db, tickets, nullifiers, dispatcher);

        bool created = await service.CreateAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.True(created);
        Comment comment = Assert.Single(db.Queryable<Comment>().ToList());
        Assert.Null(comment.UserId);
        Assert.Equal(CommentAuthorModes.ZkAnonymous, comment.AuthorMode);
        Assert.Equal(NullifierHash, comment.AnonymousNullifierHash);
        Assert.Equal("article:42", comment.AnonymousScope);
        Assert.Equal("strong_anonymous", comment.CredentialLevel);
        Assert.Equal("rep-low", comment.ReputationBucket);
        Assert.Equal("credential_bound", comment.AccountAgeBucket);
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
        Assert.Null(scope.UserId);
        Assert.False(scope.PublicArticleChanged);
    }

    [Fact]
    public async Task CreateAnonymousCommentAsync_ReplayedTicket_IsRejectedBeforeSecondWrite()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42));
        CommentService service = CreateService(db, tickets);

        Assert.True(await service.CreateAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None));
        Assert.False(await service.CreateAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None));

        Assert.Equal(1, db.Queryable<Comment>().Count());
        Assert.Equal(2, tickets.ConsumeAttempts);
    }

    [Fact]
    public async Task CreateAnonymousCommentAsync_ExpiredTicket_IsRejectedWithoutCommentOrUsageIncrement()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, expiresAtUnixMs: DateTimeOffset.UtcNow.AddSeconds(-1).ToUnixTimeMilliseconds()));
        var nullifiers = new RecordingNullifierService();
        CommentService service = CreateService(db, tickets, nullifiers);

        bool created = await service.CreateAnonymousCommentAsync(CreateRequest(), RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(0, db.Queryable<Comment>().Count());
        Assert.Empty(nullifiers.Increments);
    }

    [Fact]
    public async Task CreateAnonymousCommentAsync_TicketReplyContextMismatch_IsRejected()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentService service = CreateService(db, tickets);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "101", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.False(created);
        Assert.Equal(1, db.Queryable<Comment>().Count());
    }

    [Fact]
    public async Task CreateAnonymousCommentAsync_ValidReply_UsesServerSideReplyProjection()
    {
        using SqlSugarClient db = CreateDb();
        CreateTables(db);
        SeedArticle(db, articleId: 42);
        SeedApprovedComment(db, commentId: 100, articleId: 42, userId: 7);
        var tickets = new RecordingTicketService();
        tickets.Add(Ticket, TicketPayload(articleId: 42, parentId: 100, rootId: 100, replyToCommentId: 100));
        CommentService service = CreateService(db, tickets);
        AnonymousCommentCreateRequestCoreModel request = CreateRequest(parentId: "100", rootId: "100", replyToCommentId: "100");

        bool created = await service.CreateAnonymousCommentAsync(request, RegionDecision(), CancellationToken.None);

        Assert.True(created);
        Comment reply = db.Queryable<Comment>().OrderBy(static item => item.Id, OrderByType.Desc).First();
        Assert.Null(reply.UserId);
        Assert.Equal(100, reply.ParentId);
        Assert.Equal(100, reply.RootId);
        Assert.Equal(100, reply.ReplyToCommentId);
        Assert.Equal(7, reply.ReplyToUserId);
        Assert.Equal(1, reply.Depth);
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
            aeds,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.EmptySuccess, decoded.FrameType);
        Assert.Equal("hello anonymous", commentService.Request.Content);
        Assert.Equal(RegionCodes.Singapore, commentService.RegionDecision!.SubmitRegion);
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
        Assert.Contains("CreateAnonymousCommentAsync", source, StringComparison.Ordinal);

        Assert.Contains(".RequireAuthorization()", signedHandler, StringComparison.Ordinal);
        Assert.Contains("CreateCommentV2Async", signedHandler, StringComparison.Ordinal);
        Assert.Contains("CreateCommentAsync(userId", signedHandler, StringComparison.Ordinal);
    }

    private static CommentService CreateService(
        SqlSugarClient db,
        RecordingTicketService ticketService,
        RecordingNullifierService? nullifierService = null,
        RecordingCacheInvalidationDispatcher? dispatcher = null)
    {
        nullifierService ??= new RecordingNullifierService();
        dispatcher ??= new RecordingCacheInvalidationDispatcher();
        return new CommentService(
            db,
            NullLogger<CommentService>.Instance,
            Substitute.For<IMessageRealtimePublisher>(),
            Substitute.For<IMessageCommandService>(),
            dispatcher,
            new RegionLegalModerationService(),
            anonymousNullifierService: nullifierService,
            anonymousCommentTicketService: ticketService,
            anonymousDisplayNameGenerator: new CommentAnonymousDisplayNameGenerator());
    }

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

    private static SqlSugarClient CreateDb()
        => new(new ConnectionConfig
        {
            DbType = DbType.Sqlite,
            ConnectionString = $"Data Source={Path.Combine(Path.GetTempPath(), $"fsus-anonymous-comment-submit-{Guid.NewGuid():N}.db")}",
            InitKeyType = InitKeyType.Attribute,
            IsAutoCloseConnection = true
        });

    private static void CreateTables(SqlSugarClient db)
    {
        db.Ado.ExecuteCommand("""
            CREATE TABLE article (
                id INTEGER PRIMARY KEY,
                IsDeleted INTEGER NOT NULL,
                status INTEGER NOT NULL,
                published_at TEXT NULL,
                scheduled_publish_at TEXT NULL
            );
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE comment (
                id INTEGER PRIMARY KEY,
                article_id INTEGER NOT NULL,
                content TEXT NOT NULL,
                create_time TEXT NOT NULL,
                user_id INTEGER NULL,
                author_mode TEXT NOT NULL,
                public_handle TEXT NULL,
                anonymous_handle TEXT NULL,
                anonymous_display_name TEXT NULL,
                anonymous_display_language TEXT NULL,
                anonymous_nullifier_hash TEXT NULL,
                anonymous_scope TEXT NULL,
                moderation_subject_hash TEXT NULL,
                credential_level TEXT NULL,
                reputation_bucket TEXT NULL,
                account_age_bucket TEXT NULL,
                parent_id INTEGER NULL,
                root_id INTEGER NULL,
                reply_to_user_id INTEGER NULL,
                reply_to_comment_id INTEGER NULL,
                depth INTEGER NOT NULL,
                is_deleted INTEGER NOT NULL,
                delete_reason TEXT NULL,
                delete_time TEXT NULL,
                moderation_status INTEGER NOT NULL,
                moderation_reason TEXT NULL,
                moderated_by_user_id INTEGER NULL,
                moderated_at TEXT NULL
            );
            """);
        db.Ado.ExecuteCommand("""
            CREATE TABLE comment_region_compliance (
                id INTEGER PRIMARY KEY,
                comment_id INTEGER NOT NULL,
                submit_region TEXT NOT NULL,
                submit_region_confidence REAL NOT NULL,
                region_provider TEXT NOT NULL,
                submit_ip_hash TEXT NULL,
                policy_version TEXT NOT NULL,
                can_publish INTEGER NOT NULL,
                requires_manual_review INTEGER NOT NULL,
                hide_until_reviewed INTEGER NOT NULL,
                blocked_regions TEXT NOT NULL,
                risk_labels TEXT NOT NULL,
                decision_reason TEXT NULL,
                rule_hits_json TEXT NULL,
                created_at_utc TEXT NOT NULL,
                updated_at_utc TEXT NOT NULL
            );
            """);
    }

    private static void SeedArticle(SqlSugarClient db, int articleId)
        => db.Ado.ExecuteCommand(
            """
            INSERT INTO article (id, IsDeleted, status, published_at, scheduled_publish_at)
            VALUES (@Id, 0, @Status, @PublishedAt, NULL);
            """,
            new SugarParameter("@Id", articleId),
            new SugarParameter("@Status", (int)ArticleStatus.Published),
            new SugarParameter("@PublishedAt", DateTime.UtcNow.AddMinutes(-1)));

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

        public Task<bool> CreateAnonymousCommentAsync(
            AnonymousCommentCreateRequestCoreModel request,
            RegionModerationDecision? regionDecision = null,
            CancellationToken cancellationToken = default)
        {
            Request = request;
            RegionDecision = regionDecision;
            return Task.FromResult(true);
        }

        public Task<bool> CreateCommentAsync(int userId, CommentDto dto) => throw new NotSupportedException();
        public Task<bool> CreateCommentV2Async(int userId, CommentCreateV2RequestCoreModel request, RegionModerationDecision? regionDecision = null) => throw new NotSupportedException();
        public Task<CursorResponse<CommentThreadItemDto>> GetCommentThreadsByCursorAsync(int articleId, CursorPageRequest<long> request, int previewLimit = 3, string viewerRegion = "GLOBAL") => throw new NotSupportedException();
        public Task<CursorResponse<CommentReplyItemDto>> GetThreadRepliesByCursorAsync(int articleId, long rootId, CursorPageRequest<long> request, string viewerRegion = "GLOBAL") => throw new NotSupportedException();
        public Task<bool> DeleteCommentAsync(long id, int currentUserId, bool isAdmin, string reason = "违反社区管理条例") => throw new NotSupportedException();
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
}
