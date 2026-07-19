using System.Buffers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "SecurityStateMachine")]
public sealed class RecoveryPasskeyCompletionEndpointTests
{
    private const string CompleteRoute = "/api/binary/auth/recovery-key/passkey/register/complete";

    [Fact]
    public async Task MappedCompleteEndpoint_SuccessEmitsAedsEmptySuccess()
    {
        var recoveryKeys = Substitute.For<IRecoveryKeyService>();
        recoveryKeys.CompletePasskeyBindAsync(
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(Result<RecoveryPasskeyBindOutcome>.Success(new RecoveryPasskeyBindOutcome(false)));

        EndpointResponse response = await InvokeMappedCompleteAsync(recoveryKeys);

        Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
        Assert.Equal(AedsFrameType.EmptySuccess, response.Frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeEmptySuccess(response.Frame.Payload, out _));
        await recoveryKeys.Received(1).CompletePasskeyBindAsync(
            "raw-recovery-session-token",
            Arg.Is<PasskeyRegisterCompleteCoreModel>(request =>
                request.SessionKey == "recovery-register-challenge" &&
                request.MfaProofToken == "raw-recovery-session-token"),
            Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(ErrorCode.Conflict, "RECOVERY_PASSKEY_COMPLETION_IN_PROGRESS", StatusCodes.Status409Conflict)]
    [InlineData(ErrorCode.InfraFailure, "RECOVERY_PASSKEY_RETRYABLE", StatusCodes.Status500InternalServerError)]
    public async Task MappedCompleteEndpoint_StateMachineFailureEmitsAedsApiError(
        ErrorCode code,
        string message,
        int expectedStatus)
    {
        var recoveryKeys = Substitute.For<IRecoveryKeyService>();
        recoveryKeys.CompletePasskeyBindAsync(
                Arg.Any<string>(),
                Arg.Any<PasskeyRegisterCompleteCoreModel>(),
                Arg.Any<CancellationToken>())
            .Returns(Result<RecoveryPasskeyBindOutcome>.Failure(code, message));

        EndpointResponse response = await InvokeMappedCompleteAsync(recoveryKeys);

        Assert.Equal(expectedStatus, response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, response.Frame.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(response.Frame.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(code, error.Code);
        Assert.Equal(message, error.Message);
    }

    private static async Task<EndpointResponse> InvokeMappedCompleteAsync(IRecoveryKeyService recoveryKeys)
    {
        var request = new PasskeyRegisterCompleteCoreModel
        {
            SessionKey = "recovery-register-challenge",
            Id = "recovery-credential",
            RawId = [1, 2, 3],
            ClientDataBytes = [4, 5, 6],
            AttestationObject = [7, 8, 9],
            Transports = [1],
            FriendlyName = "Recovery credential",
            MfaProofToken = "raw-recovery-session-token"
        };
        var payload = new ArrayBufferWriter<byte>();
        PodBinaryCodec.WritePasskeyRegisterCompleteRequest(request, payload);
        var aeds = new AedsEncoder();
        var requestContext = new FixedBinaryRequestContext(
            AedsFrameType.PasskeyRegisterCompleteRequest,
            BinaryRequestPayload.Success(payload.WrittenMemory));
        using ServiceProvider services = new ServiceCollection()
            .AddSingleton<IAedsEncoder>(aeds)
            .AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>()
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .AddSingleton(recoveryKeys)
            .BuildServiceProvider();
        await using WebApplication app = EndpointContractApplication.Create();
        RouteEndpoint endpoint = EndpointContractApplication.Find(app, CompleteRoute, HttpMethods.Post);
        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        context.Request.Method = HttpMethods.Post;
        context.Response.Body = new MemoryStream();
        context.SetEndpoint(endpoint);

        Assert.NotNull(endpoint.RequestDelegate);
        await endpoint.RequestDelegate!(context);

        Result<AedsDecodeResult> decoded = aeds.TryDecode(((MemoryStream)context.Response.Body).ToArray());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return new EndpointResponse(context.Response.StatusCode, decoded.Value);
    }

    private sealed record EndpointResponse(int StatusCode, AedsDecodeResult Frame);

    private sealed class FixedBinaryRequestContext(
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

        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache)
            => throw new NotSupportedException();

        public string BuildArticleListCacheIdentity(
            long version,
            int page,
            int size,
            int? categoryId,
            int? tagId,
            bool isDeleted,
            int? status = null,
            bool includePrivate = false,
            string keyword = "")
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
