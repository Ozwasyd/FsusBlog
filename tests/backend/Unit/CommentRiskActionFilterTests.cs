using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CommentRiskActionFilterTests
{
    [Theory]
    [InlineData(false, RiskActionNames.CommentCreate, "comment.create")]
    [InlineData(true, RiskActionNames.CommentReply, "comment.reply")]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_RealCreateAndReplyFramesSetDynamicActionResetBodyAndPreservePayload(
        bool isReply,
        string expectedAction,
        string expectedRoute)
    {
        var aeds = new AedsEncoder();
        byte[] frame = CreateFrame(aeds, isReply);
        var context = new DefaultHttpContext();
        context.Request.Body = new MemoryStream(frame);
        context.Request.ContentLength = frame.Length;
        var filter = new CommentRiskActionFilter(aeds, NullLogger<CommentRiskActionFilter>.Instance);

        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                Assert.Equal(0, context.Request.Body.Position);
                using var copy = new MemoryStream();
                context.Request.Body.CopyTo(copy);
                Assert.Equal(frame, copy.ToArray());
                RiskActionEndpointMetadata metadata = Assert.IsType<RiskActionEndpointMetadata>(
                    context.Items[RiskActionEndpointMetadata.HttpContextItemKey]);
                Assert.Equal(expectedAction, metadata.ActionName);
                Assert.Equal(expectedRoute, metadata.RouteKey);
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.Equal("ok", result);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_MalformedFrameFallsBackToCreateAndResetsSeekableBody()
    {
        var aeds = new AedsEncoder();
        byte[] malformed = [1, 2, 3, 4, 5];
        var context = new DefaultHttpContext();
        context.Request.Body = new MemoryStream(malformed);
        context.Request.ContentLength = malformed.Length;
        var filter = new CommentRiskActionFilter(aeds, NullLogger<CommentRiskActionFilter>.Instance);

        await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                Assert.Equal(0, context.Request.Body.Position);
                RiskActionEndpointMetadata metadata = Assert.IsType<RiskActionEndpointMetadata>(
                    context.Items[RiskActionEndpointMetadata.HttpContextItemKey]);
                Assert.Equal(RiskActionNames.CommentCreate, metadata.ActionName);
                return ValueTask.FromResult<object?>(null);
            });
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_NonSeekableBodyIsBufferedAndReplyFrameRemainsReadableByMutation()
    {
        var aeds = new AedsEncoder();
        byte[] frame = CreateFrame(aeds, isReply: true);
        var context = new DefaultHttpContext();
        context.Request.Body = new NonSeekableReadStream(frame);
        context.Request.ContentLength = frame.Length;
        var filter = new CommentRiskActionFilter(aeds, NullLogger<CommentRiskActionFilter>.Instance);

        await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                Assert.True(context.Request.Body.CanSeek);
                Assert.Equal(0, context.Request.Body.Position);
                using var copy = new MemoryStream();
                context.Request.Body.CopyTo(copy);
                Assert.Equal(frame, copy.ToArray());
                RiskActionEndpointMetadata metadata = Assert.IsType<RiskActionEndpointMetadata>(
                    context.Items[RiskActionEndpointMetadata.HttpContextItemKey]);
                Assert.Equal(RiskActionNames.CommentReply, metadata.ActionName);
                return ValueTask.FromResult<object?>(null);
            });
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Concurrency, ConcurrencyHarness = "fsusblog.real-concurrency.v1")]
    public async Task InvokeAsync_RequestCancellationPropagatesWithoutCallingMutationAndResetsBuffer()
    {
        var aeds = new AedsEncoder();
        var body = new CancelableBlockingReadStream();
        var context = new DefaultHttpContext();
        using var cancellation = new CancellationTokenSource();
        context.RequestAborted = cancellation.Token;
        context.Request.Body = body;
        context.Request.ContentLength = 128;
        var filter = new CommentRiskActionFilter(aeds, NullLogger<CommentRiskActionFilter>.Instance);
        bool nextCalled = false;

        await RealConcurrencyHarness.RunInterleavedAsync(
            async () =>
            {
                Task<object?> pending = filter.InvokeAsync(
                    new TestEndpointFilterInvocationContext(context),
                    _ =>
                    {
                        nextCalled = true;
                        return ValueTask.FromResult<object?>(null);
                    }).AsTask();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            },
            async pending =>
            {
                await body.ReadStarted.Task.WaitAsync(TimeSpan.FromSeconds(1));
                cancellation.Cancel();

                await pending;
                Assert.False(nextCalled);
                Assert.True(context.Request.Body.CanSeek);
                Assert.Equal(0, context.Request.Body.Position);
            },
            () => cancellation.Cancel());
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_OversizedPreviewDefaultsToCreateWithoutReadingBody()
    {
        var aeds = new AedsEncoder();
        var body = new ThrowOnReadStream();
        var context = new DefaultHttpContext();
        context.Request.Body = body;
        context.Request.ContentLength = long.MaxValue;
        var filter = new CommentRiskActionFilter(aeds, NullLogger<CommentRiskActionFilter>.Instance);

        await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                RiskActionEndpointMetadata metadata = Assert.IsType<RiskActionEndpointMetadata>(
                    context.Items[RiskActionEndpointMetadata.HttpContextItemKey]);
                Assert.Equal(RiskActionNames.CommentCreate, metadata.ActionName);
                return ValueTask.FromResult<object?>(null);
            });

        Assert.Equal(0, body.ReadCount);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Positive)]
    public void RiskControlContextFactory_PrefersDynamicCommentActionOverEndpointDefault()
    {
        var context = new DefaultHttpContext();
        context.SetEndpoint(new Endpoint(
            _ => Task.CompletedTask,
            new EndpointMetadataCollection(
                RiskActionRegistry.Default.CreateMetadata(RiskActionNames.CommentCreate)),
            "comment"));
        context.Items[RiskActionEndpointMetadata.HttpContextItemKey] =
            RiskActionRegistry.Default.CreateMetadata(RiskActionNames.CommentReply);

        RiskControlContext riskContext = new RiskControlContextFactory().Create(context);

        Assert.Equal(RiskActionNames.CommentReply, riskContext.ActionName);
        Assert.Equal("comment.reply", riskContext.RouteKey);
    }

    [Fact]
    [CoversBehavior("article-comment-lifecycle-outbox", BehaviorTestKind.Negative, InvariantId = "auth-article-queue-for-moderation-decision-continues-comment-mutation-with-hidden-manual-review-context")]
    public async Task QueueForModerationDecision_ContinuesCommentMutationWithHiddenManualReviewContext()
    {
        var aeds = new AedsEncoder();
        var commentService = new CapturingCommentEndpointService();
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/comment/anonymous";
        context.Items[RiskControlDecisionContext.HttpContextItemKey] = new RiskControlDecisionContext(new RiskDecision(
            RiskDecisionKind.QueueForModeration,
            RiskActionNames.CommentCreate,
            "comment.create",
            RiskScore: 90,
            EffectiveRiskScore: 90,
            EscalationLevel: 3,
            RequiredChallenges: [],
            PolicyVersion: "policy-v2",
            Reasons: ["risk_queue_threshold"]));
        byte[] payload = PodBinaryCodec.EncodeAnonymousCommentCreateRequest(new AnonymousCommentCreateRequestCoreModel(
            ArticleId: 42,
            Content: "queued comment",
            ParentId: null,
            RootId: null,
            ReplyToCommentId: null,
            AnonymousScope: "article:42",
            DisplayLanguage: "en",
            Ticket: [1, 2, 3]));
        using ServiceProvider requestServices = new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(new FixedBinaryRequestContext(
                AedsFrameType.AnonymousCommentCreateRequest,
                BinaryRequestPayload.Success(payload)))
            .BuildServiceProvider();
        context.RequestServices = requestServices;

        _ = await BinaryEndpoints.HandleAnonymousCommentCreateAsync(
            context,
            commentService,
            new AllowingContentFilter(),
            new FixedClientRegionResolver(),
            new RegionLegalModerationService(),
            new NullRiskSignalSink(),
            FixedZkAnonymousProofService.Available(),
            aeds,
            CancellationToken.None);

        Assert.Equal(1, commentService.CreateCalls);
        RegionModerationDecision decision = Assert.IsType<RegionModerationDecision>(commentService.RegionDecision);
        Assert.True(decision.RequiresManualReview);
        Assert.True(decision.HideUntilReviewed);
        Assert.Contains("risk_control_queue", decision.RiskLabels);
        Assert.Contains("risk_action:comment.create", decision.RiskLabels);
        Assert.Contains("risk_score:90", decision.RiskLabels);
        Assert.Contains("risk_control_queue:risk_queue_threshold", decision.DecisionReason, StringComparison.Ordinal);
    }

    private static byte[] CreateFrame(AedsEncoder aeds, bool isReply)
        => aeds.Encode(
            AedsFrameType.CommentCreateRequest,
            PodBinaryCodec.EncodeCommentCreateRequest(new CommentCreateRequestCoreModel(
                ArticleId: 42,
                Content: isReply ? "reply" : "root",
                ParentId: isReply ? "100" : null,
                RootId: isReply ? "100" : null,
                ReplyToCommentId: isReply ? "100" : null,
                AuthorMode: "anonymous",
                PublicSendExplicitlySelected: false,
                AnonymousScope: null,
                DisplayLanguage: null,
                ProofToken: null,
                ZkProof: [])));

    private sealed class TestEndpointFilterInvocationContext(HttpContext httpContext) : EndpointFilterInvocationContext
    {
        public override HttpContext HttpContext { get; } = httpContext;
        public override IList<object?> Arguments { get; } = [];
        public override T GetArgument<T>(int index) => (T)Arguments[index]!;
    }

    private sealed class NonSeekableReadStream(byte[] bytes) : Stream
    {
        private readonly MemoryStream _inner = new(bytes, writable: false);
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override void Flush()
        {
        }
        public override int Read(byte[] buffer, int offset, int count) => _inner.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => _inner.ReadAsync(buffer, cancellationToken);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => _inner.ReadAsync(buffer, offset, count, cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing)
                _inner.Dispose();
            base.Dispose(disposing);
        }
    }

    private sealed class CancelableBlockingReadStream : Stream
    {
        public TaskCompletionSource ReadStarted { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override void Flush()
        {
        }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            ReadStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }
        public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
        {
            ReadStarted.TrySetResult();
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            return 0;
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class ThrowOnReadStream : Stream
    {
        public int ReadCount
        {
            get; private set;
        }
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }
        public override void Flush()
        {
        }
        public override int Read(byte[] buffer, int offset, int count)
        {
            ReadCount++;
            throw new InvalidOperationException("body must not be read");
        }
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            ReadCount++;
            throw new InvalidOperationException("body must not be read");
        }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }

    private sealed class CapturingCommentEndpointService : ICommentEndpointService
    {
        public int CreateCalls
        {
            get; private set;
        }
        public RegionModerationDecision? RegionDecision
        {
            get; private set;
        }

        public Task<bool> CreateStrongAnonymousCommentAsync(
            AnonymousCommentCreateRequestCoreModel request,
            RegionModerationDecision? regionDecision = null,
            CancellationToken cancellationToken = default)
        {
            CreateCalls++;
            RegionDecision = regionDecision;
            return Task.FromResult(true);
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
        public ContentValidationResult ValidateContent(string text) => new(true, "ok", "ok");
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

    private sealed class FixedBinaryRequestContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload) : IBinaryEndpointRequestContext
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

        public Task<NameMutationPayload> ReadNameMutationAsync(HttpContext httpContext, IAedsEncoder aeds, AedsFrameType expected, CancellationToken cancellationToken) => throw new NotSupportedException();
        public string BuildArticleViewerIdentity(HttpContext context, int articleId) => throw new NotSupportedException();
        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache) => throw new NotSupportedException();
        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "") => throw new NotSupportedException();
        public string BuildArticleHotCacheIdentity(int count) => throw new NotSupportedException();
        public string? GetDeviceFingerprint(HttpContext context) => null;
        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }

    private sealed class FixedZkAnonymousProofService : IZkAnonymousProofService
    {
        public AnonymousCommentPolicySnapshot CurrentCommentPolicy { get; } = AnonymousCommentPolicySnapshot.Default with { ZkAnonymousEnabled = true };
        public ZkAnonymousPolicySnapshot CurrentZkPolicy { get; } = new(true, true, "comment.create", []);
        public ZkCommentPolicySnapshot CurrentZkCommentPolicy { get; } = new(true, true, true, true, true, string.Empty);

        public static FixedZkAnonymousProofService Available() => new();

        public Task<ZkProofVerificationResult> VerifyCommentProofAsync(
            ZkProofVerificationRequest request,
            CancellationToken cancellationToken = default)
            => Task.FromResult(ZkProofVerificationResult.VerifierUnavailable());
    }
}
