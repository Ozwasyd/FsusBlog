using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ReadProofBinaryEndpointTests
{
    [Fact]
    public async Task ChallengeAsync_ValidAedsRequest_ReturnsChallengeFrame()
    {
        var aeds = new AedsEncoder();
        var request = new HumanReadChallengeRequest("article", "article:42", 42);
        var context = CreateContext(
            AedsFrameType.HumanReadChallengeRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeHumanReadChallengeRequest(request)));
        var proofAdapter = new FakeProofAdapter();
        var riskSink = Substitute.For<ISecurityRiskSignalSink>();
        var issued = new DateTimeOffset(2026, 5, 20, 8, 30, 0, TimeSpan.Zero);
        var response = new HumanReadChallengeResponse("token-1", "article", "article:42", 42, 8000, issued, issued.AddMinutes(5));
        proofAdapter.ChallengeResponse = response;

        BinaryFrameResult result = await BinaryEndpoints.HandleHumanReadChallengeAsync(context, proofAdapter, riskSink, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.HumanReadChallengeResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeHumanReadChallengeResponse(decoded.Payload, out HumanReadChallengeResponse body));
        Assert.Equal("token-1", body.Token);
        Assert.Equal(42, body.ArticleId);
        Assert.Equal(request, proofAdapter.ChallengeRequest);
        await riskSink.DidNotReceiveWithAnyArgs().AddRiskAsync(default!, default);
    }

    [Fact]
    public async Task ChallengeAsync_RejectedChallenge_WritesRiskSignalAndKeepsLegacyFallbackShape()
    {
        var aeds = new AedsEncoder();
        var request = new HumanReadChallengeRequest("ARTICLE", "   ", 42);
        var context = CreateContext(
            AedsFrameType.HumanReadChallengeRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeHumanReadChallengeRequest(request)));
        var proofAdapter = new FakeProofAdapter();
        var riskSink = Substitute.For<ISecurityRiskSignalSink>();

        BinaryFrameResult result = await BinaryEndpoints.HandleHumanReadChallengeAsync(context, proofAdapter, riskSink, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.HumanReadChallengeResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeHumanReadChallengeResponse(decoded.Payload, out HumanReadChallengeResponse body));
        Assert.Empty(body.Token);
        Assert.Equal("article", body.Scope);
        Assert.Equal("article", body.RouteKey);
        Assert.Equal(42, body.ArticleId);
        await riskSink.Received(1).AddRiskAsync(
            Arg.Is<SecurityRiskSignal>(signal =>
                signal.Reason == SecurityRiskReason.ReadProofRejected &&
                signal.Source == SecurityRiskSources.HumanReadProof &&
                signal.Score == 5 &&
                signal.Detail == "challenge_rejected"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SubmitAsync_ValidAedsRequest_ReturnsSubmitFrame()
    {
        var aeds = new AedsEncoder();
        var request = new HumanReadSubmitRequest("token-1", "site", "home", null, 9000);
        var context = CreateContext(
            AedsFrameType.HumanReadSubmitRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeHumanReadSubmitRequest(request)));
        var proofAdapter = new FakeProofAdapter();
        var riskSink = Substitute.For<ISecurityRiskSignalSink>();
        proofAdapter.SubmitResponse = new HumanReadSubmitResponse(true, "counted");

        BinaryFrameResult result = await BinaryEndpoints.HandleHumanReadSubmitAsync(context, proofAdapter, riskSink, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.HumanReadSubmitResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeHumanReadSubmitResponse(decoded.Payload, out HumanReadSubmitResponse body));
        Assert.True(body.Counted);
        Assert.Equal("counted", body.Status);
        Assert.Equal(request, proofAdapter.SubmitRequest);
        await riskSink.Received(1).AddRiskAsync(
            Arg.Is<SecurityRiskSignal>(signal =>
                signal.Reason == SecurityRiskReason.ReadProofAccepted &&
                signal.Source == SecurityRiskSources.HumanReadProof &&
                signal.Action == RiskActionNames.PublicRead &&
                signal.Score < 0 &&
                signal.Detail == "counted"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task SubmitAsync_RejectedProof_WritesRiskSignal()
    {
        var aeds = new AedsEncoder();
        var request = new HumanReadSubmitRequest("token-1", "site", "home", null, 9000);
        var context = CreateContext(
            AedsFrameType.HumanReadSubmitRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeHumanReadSubmitRequest(request)));
        var proofAdapter = new FakeProofAdapter();
        var riskSink = Substitute.For<ISecurityRiskSignalSink>();
        proofAdapter.SubmitResponse = new HumanReadSubmitResponse(false, "proof_replayed");

        _ = await BinaryEndpoints.HandleHumanReadSubmitAsync(context, proofAdapter, riskSink, aeds, CancellationToken.None);

        await riskSink.Received(1).AddRiskAsync(
            Arg.Is<SecurityRiskSignal>(signal =>
                signal.Reason == SecurityRiskReason.ReadProofRejected &&
                signal.Source == SecurityRiskSources.HumanReadProof &&
                signal.Score == 20 &&
                signal.Detail == "proof_replayed"),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task ChallengeAsync_MalformedPayload_ReturnsApiErrorFrame()
    {
        var aeds = new AedsEncoder();
        var context = CreateContext(
            AedsFrameType.HumanReadChallengeRequest,
            BinaryRequestPayload.Success(new byte[] { 0x01, 0x02 }));
        var proofAdapter = new FakeProofAdapter();
        var riskSink = Substitute.For<ISecurityRiskSignalSink>();

        BinaryFrameResult result = await BinaryEndpoints.HandleHumanReadChallengeAsync(context, proofAdapter, riskSink, aeds, CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.Validation, error.Code);
        Assert.Equal("read_proof_challenge_request_invalid", error.Message);
        Assert.Null(proofAdapter.ChallengeRequest);
    }

    private static DefaultHttpContext CreateContext(AedsFrameType expectedFrameType, BinaryRequestPayload payload)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        var requestContext = new FakeBinaryEndpointRequestContext(expectedFrameType, payload);

        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .BuildServiceProvider();
        return context;
    }

    private static async Task<AedsDecodeResult> ExecuteAndDecodeAsync(BinaryFrameResult result, DefaultHttpContext context, AedsEncoder aeds)
    {
        await result.ExecuteAsync(context);
        var frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);

        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }

    private sealed class FakeProofAdapter : IHumanReadProofEndpointAdapter
    {
        public HumanReadChallengeRequest? ChallengeRequest { get; private set; }
        public HumanReadChallengeResponse? ChallengeResponse { get; set; }
        public HumanReadSubmitRequest? SubmitRequest { get; private set; }
        public HumanReadSubmitResponse SubmitResponse { get; set; } = new(false, "proof_invalid");

        public ValueTask<HumanReadChallengeResponse?> CreateChallengeAsync(
            HttpContext context,
            HumanReadChallengeRequest request,
            CancellationToken cancellationToken)
        {
            ChallengeRequest = request;
            return ValueTask.FromResult(ChallengeResponse);
        }

        public ValueTask<HumanReadSubmitResponse> SubmitAsync(
            HttpContext context,
            HumanReadSubmitRequest request,
            CancellationToken cancellationToken)
        {
            SubmitRequest = request;
            return ValueTask.FromResult(SubmitResponse);
        }
    }

    private sealed class FakeBinaryEndpointRequestContext(
        AedsFrameType expectedFrameType,
        BinaryRequestPayload payload) : IBinaryEndpointRequestContext
    {
        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Equal(expectedFrameType, expected);
            return Task.FromResult(payload);
        }

        public Task<BinaryRequestPayload> ReadFrameAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            IReadOnlyCollection<AedsFrameType> expected,
            CancellationToken cancellationToken,
            int? maxFrameBytes = null)
        {
            Assert.Contains(expectedFrameType, expected);
            return Task.FromResult(payload);
        }

        public Task<NameMutationPayload> ReadNameMutationAsync(
            HttpContext httpContext,
            IAedsEncoder aeds,
            AedsFrameType expectedFrameType,
            CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public string BuildArticleViewerIdentity(HttpContext context, int articleId)
            => throw new NotSupportedException();

        public ValueTask<long> GetArticleListCacheVersionAsync(IUnifiedCache cache)
            => throw new NotSupportedException();

        public string BuildArticleListCacheIdentity(long version, int page, int size, int? categoryId, int? tagId, bool isDeleted, int? status = null, bool includePrivate = false, string keyword = "")
            => throw new NotSupportedException();

        public string BuildArticleHotCacheIdentity(int count)
            => throw new NotSupportedException();

        public string? GetDeviceFingerprint(HttpContext context)
            => null;

        public bool TryReadMfaProof(HttpContext context, out string proofToken)
        {
            proofToken = string.Empty;
            return false;
        }
    }
}
