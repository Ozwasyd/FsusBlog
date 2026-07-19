using System.Security.Claims;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class UserSecurityStepUpServiceTests
{
    private const string StableAccountSubjectHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task MfaEnabledAccount_RequiresActionBoundOneTimeProof()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: true));
        mfa.ValidateAndConsumeProofTokenAsync(42, StableAccountSubjectHash, UserSecurityStepUpActions.PasskeyDelete, "proof-1")
            .Returns(true, false);
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult first = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));
        UserSecurityStepUpResult replay = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));
        UserSecurityStepUpResult wrongAction = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        Assert.True(first.Success);
        Assert.False(replay.Success);
        Assert.False(wrongAction.Success);
        await mfa.Received(2).ValidateAndConsumeProofTokenAsync(42, StableAccountSubjectHash, UserSecurityStepUpActions.PasskeyDelete, "proof-1");
        await mfa.Received(1).ValidateAndConsumeProofTokenAsync(42, StableAccountSubjectHash, UserSecurityStepUpActions.RecoveryKeyCreate, "proof-1");
    }

    [Fact]
    public void AccountDelete_IsCredentialMutationAction()
    {
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.AccountDelete));
    }

    [Fact]
    public void UserSecurityStepUpRequest_UsesAccountIdAndFriendlyNameUpdateAction()
    {
        Assert.NotNull(typeof(UserSecurityStepUpRequest).GetProperty("AccountId"));
        Assert.Null(typeof(UserSecurityStepUpRequest).GetProperty("UserId"));
        Assert.Equal("passkey.credential-name.update", UserSecurityStepUpActions.PasskeyCredentialNameUpdate);
        Assert.True(UserSecurityStepUpActions.IsCredentialMutation(UserSecurityStepUpActions.PasskeyCredentialNameUpdate));
    }

    [Fact]
    public async Task MfaEnabledAccount_DoesNotAcceptPasswordFallback()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: true));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            new UserSecurityStepUpProof(),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("MFA_PROOF_REQUIRED", result.Message);
    }

    [Fact]
    public async Task NonMfaAccount_StillRequiresAnonymousStepUpProof()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyCredentialNameUpdate,
            new UserSecurityStepUpProof(),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("ANONYMOUS_STEP_UP_PROOF_REQUIRED", result.Message);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!, default!);
    }

    [Fact]
    public async Task PasswordProof_IsNotAcceptedAsAnonymousStepUp()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, result.StatusCode);
        Assert.Equal("ANONYMOUS_STEP_UP_PROOF_REQUIRED", result.Message);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!, default!);
    }

    [Fact]
    public async Task MissingDeletedOrBannedAccount_FailsClosedWithoutCheckingProofs()
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        var service = new UserSecurityStepUpService(users, mfa);

        users.GetAccountByIdAsync(42).Returns((UserAccountSnapshot?)null);
        UserSecurityStepUpResult missing = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.PasskeyDelete,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, deletedAt: DateTime.UtcNow));
        UserSecurityStepUpResult deleted = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        users.GetAccountByIdAsync(42).Returns(CreateUser(mfaEnabled: false, status: 2));
        UserSecurityStepUpResult banned = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyRotate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-1"),
            "203.0.113.10"));

        Assert.False(missing.Success);
        Assert.False(deleted.Success);
        Assert.False(banned.Success);
        Assert.Equal(StatusCodes.Status401Unauthorized, missing.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, deleted.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, banned.StatusCode);
        await mfa.DidNotReceiveWithAnyArgs().ValidateAndConsumeProofTokenAsync(default, default!, default!, default!);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("not-a-sha256-subject")]
    public async Task MissingOrMalformedPhysicalSubject_FailsClosedBeforeProofValidation(string? accountSubjectHash)
    {
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IMfaChallengeService mfa = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(CreateUser(
            mfaEnabled: true,
            accountSubjectHash: accountSubjectHash));
        var service = new UserSecurityStepUpService(users, mfa);

        UserSecurityStepUpResult result = await service.VerifyAsync(new UserSecurityStepUpRequest(
            42,
            UserSecurityStepUpActions.RecoveryKeyCreate,
            new UserSecurityStepUpProof(MfaProofToken: "proof-must-not-be-consumed"),
            "203.0.113.10"));

        Assert.False(result.Success);
        Assert.Equal(ErrorCode.Unauthorized, result.ErrorCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, result.StatusCode);
        Assert.Equal("ACCOUNT_SUBJECT_REQUIRED", result.Message);
        await users.Received(1).GetAccountByIdAsync(42);
        Assert.Empty(mfa.ReceivedCalls());
    }

    private static UserAccountSnapshot CreateUser(
        bool mfaEnabled,
        int status = 0,
        DateTime? deletedAt = null,
        string? accountSubjectHash = StableAccountSubjectHash)
        => new(
            Id: 42,
            Status: status,
            BanReason: null,
            MfaEnabled: mfaEnabled,
            DeletedAt: deletedAt,
            PublicHandle: null,
            IdentityKind: AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            AccountSubjectHash: accountSubjectHash);
}

public sealed class UserIdentityRetirementBinaryEndpointTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("not-a-sha256-subject")]
    public async Task MfaChallengeStart_MissingOrMalformedPhysicalSubjectReturnsAccountSubjectRequired(
        string? accountSubjectHash)
    {
        var aeds = new AedsEncoder();
        IUserAccountReader users = Substitute.For<IUserAccountReader>();
        IUserLoginWorkflowService loginWorkflow = Substitute.For<IUserLoginWorkflowService>();
        IMfaChallengeService challengeService = Substitute.For<IMfaChallengeService>();
        users.GetAccountByIdAsync(42).Returns(new UserAccountSnapshot(
            Id: 42,
            Status: 0,
            BanReason: null,
            MfaEnabled: true,
            DeletedAt: null,
            PublicHandle: null,
            IdentityKind: AnonymousIdentityRuntime.AnonymousAccountKind,
            PasskeyEnabled: true,
            RecoveryEnabled: true,
            AccountSubjectHash: accountSubjectHash));
        var requestContext = new IdentityRetirementBinaryRequestContext(
            AedsFrameType.MfaChallengeStartRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeStringMutationRequest(
                UserSecurityStepUpActions.RecoveryKeyCreate)));

        using ServiceProvider requestServices = new ServiceCollection()
            .AddSingleton<IAedsEncoder>(aeds)
            .AddSingleton<IBinaryEnvelopePolicy, BinaryEnvelopePolicy>()
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .AddSingleton(users)
            .AddSingleton(loginWorkflow)
            .AddSingleton(challengeService)
            .BuildServiceProvider();
        await using WebApplication app = EndpointContractApplication.Create();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/auth/mfa/challenge/start",
            HttpMethods.Post);
        var context = new DefaultHttpContext
        {
            RequestServices = requestServices,
            User = new ClaimsPrincipal(new ClaimsIdentity(
            [
                new Claim(ClaimTypes.NameIdentifier, "42"),
                new Claim("identity_kind", AnonymousIdentityRuntime.AnonymousAccountKind)
            ],
            "identity-retirement-test"))
        };
        context.Request.Method = HttpMethods.Post;
        context.Response.Body = new MemoryStream();
        context.SetEndpoint(endpoint);

        Assert.NotNull(endpoint.RequestDelegate);
        await endpoint.RequestDelegate!(context);

        byte[] frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out ApiErrorPod errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.Unauthorized, error.Code);
        Assert.Equal("ACCOUNT_SUBJECT_REQUIRED", error.Message);
        await users.Received(1).GetAccountByIdAsync(42);
        Assert.Empty(loginWorkflow.ReceivedCalls());
        Assert.Empty(challengeService.ReceivedCalls());
    }

    private sealed class IdentityRetirementBinaryRequestContext(
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
