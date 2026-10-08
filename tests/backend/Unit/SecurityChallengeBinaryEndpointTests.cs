using System.Net;
using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeBinaryEndpointTests
{
    private const int SecurityChallengeVerifyDefaultMaxAttempts = 3;
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task IssueAsync_ChallengeDecision_ReturnsChallengeResponseFrame()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest(
            "public.read", "article:42", "device-123456", "{}", SecurityChallengeCapabilityCatalog.ManifestVersion);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        context.Request.Headers["X-Fsus-Device-Fp"] = "request-context-device";
        var orchestrator = new FakeChallengeOrchestrator();
        SecurityChallengeAssignment assignment = CreateAssignment();
        orchestrator.IssueResult = SecurityChallengeOrchestrationIssueResult.Success(
            new SecurityChallengeEnvelope(SecurityChallengeContracts.CreateChallengeId(), SecurityRiskPolicyFactory.DefaultPolicyVersion, [assignment]),
            new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal)
            {
                [assignment.ChallengeId] = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["salt"] = "salt-1",
                    ["difficulty"] = "16"
                }
            });

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(Sha256PowChallengeProvider.WireKind)),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.SecurityChallengeIssueResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueResponse(decoded.Payload, out SecurityChallengeIssueBinaryResponse response));
        Assert.Equal(SecurityChallengeDecisionKind.Challenge, response.Decision);
        Assert.Equal(50, response.RiskScore);
        Assert.Equal(1, response.EscalationLevel);
        Assert.NotNull(response.Envelope);
        Assert.Equal(assignment.ChallengeId, Assert.Single(response.ProviderPayloads).ChallengeId);
        Assert.Contains("\"salt\":\"salt-1\"", response.ProviderPayloads[0].PayloadJson, StringComparison.Ordinal);
        Assert.NotNull(orchestrator.LastIssueRequest);
        Assert.Equal(Sha256PowChallengeProvider.WireKind, orchestrator.LastIssueRequest.Decision.RequiredChallenges[0]);
        Assert.Matches("^[0-9a-f]{64}$", orchestrator.LastIssueRequest.SubjectHash);
        Assert.Equal(
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes("request-context-device"))),
            orchestrator.LastIssueRequest.DeviceFpHash);
        Assert.NotEqual(
            Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(request.DeviceFingerprint))),
            orchestrator.LastIssueRequest.DeviceFpHash);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task IssueAsync_CharacterV3Decision_WritesGenericChallengeRiskSignal()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest(
            "auth.login", "auth.login", "device-123456", "{}", SecurityChallengeCapabilityCatalog.ManifestVersion);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator();
        SecurityChallengeAssignment assignment = CreateAssignment(SecurityChallengeKind.PerceptionCharacterV3) with
        {
            Action = RiskActionNames.AuthLogin,
            RouteKey = "auth.login"
        };
        orchestrator.IssueResult = SecurityChallengeOrchestrationIssueResult.Success(
            new SecurityChallengeEnvelope(SecurityChallengeContracts.CreateChallengeId(), SecurityRiskPolicyFactory.DefaultPolicyVersion, [assignment]));
        var riskSink = new CapturingRiskSink();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy("perceptionCharacterV3")),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            riskSink,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.SecurityChallengeIssueResponse, decoded.FrameType);
        Assert.Empty(riskSink.Signals);
        Assert.NotNull(orchestrator.LastIssueRequest);
        Assert.Equal(["perceptionCharacterV3"], orchestrator.LastIssueRequest.Decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-v3-closed-until-activation")]
    public async Task BinaryIssueAndVerify_V3StayClosedUntilProtocolActivation_WithoutCallingProvider()
    {
        var aeds = new AedsEncoder();
        ISecurityChallengeProvider provider = Substitute.For<ISecurityChallengeProvider>();
        provider.Kind.Returns(PerceptionCharacterV3Contracts.WireName);
        provider.IssueAsync(Arg.Any<SecurityChallengeProviderIssueRequest>(), Arg.Any<CancellationToken>())
            .Returns(SecurityChallengeProviderIssueResult.Failed("expected-test-stop"));
        provider.VerifyAsync(Arg.Any<SecurityChallengeProviderVerifyRequest>(), Arg.Any<CancellationToken>())
            .Returns(SecurityChallengeProviderVerifyResult.Failed("expected-test-stop"));
        ISecurityChallengeProtocolActivationGuard guard = Substitute.For<ISecurityChallengeProtocolActivationGuard>();
        guard.IsOpenAsync(Arg.Any<CancellationToken>()).Returns(false);
        ISecurityChallengeEnvelopeStateService stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        SecurityChallengeEnvelopeState reservedState = new(
            SecurityChallengeContracts.CreateChallengeId(),
            "public.read",
            "article:42",
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            "risk-v1",
            [SecurityChallengeContracts.CreateChallengeId()],
            [PerceptionCharacterV3Contracts.WireName],
            [SecurityChallengeEnvelopeMemberStatuses.Verifying],
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            SecurityChallengeEnvelopeStatuses.Active,
            Version: 1);
        stateService.ValidateMemberAsync(Arg.Any<SecurityChallengeEnvelopeMemberRequest>(), Arg.Any<CancellationToken>())
            .Returns(new SecurityChallengeEnvelopeMemberResult(true, "ok", reservedState, 0, 0, 1, false));
        stateService.ReserveMemberAsync(Arg.Any<SecurityChallengeEnvelopeMemberRequest>(), Arg.Any<CancellationToken>())
            .Returns(new SecurityChallengeEnvelopeMemberResult(true, "ok", reservedState, 0, 0, 1, false));
        var orchestrator = new SecurityChallengeOrchestrator(
            [provider],
            Substitute.For<ISecurityChallengeProofService>(),
            Substitute.For<ISecurityRiskSignalSink>(),
            stateService,
            protocolActivationGuard: guard);
        var issueRequest = new SecurityChallengeIssueBinaryRequest(
            "auth.login", "auth.login", "device-123456", "{}", SecurityChallengeCapabilityCatalog.ManifestVersion);
        var issueContext = CreateContext(AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(issueRequest)));

        _ = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            issueContext, aeds, new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(PerceptionCharacterV3Contracts.WireName)),
            new RiskControlContextFactory(), new RiskDecisionService(), orchestrator,
            new NullRiskSink(), CancellationToken.None);

        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        var typed = new PerceptionCharacterV3VerifyPayload(
            PerceptionCharacterV3Contracts.Algorithm, challengeId, envelopeId,
            PerceptionCharacterV3Representation.Visual, "A7C9Q", "opaque-state");
        var verifyRequest = new SecurityChallengeVerifyBinaryRequest(
            envelopeId, challengeId, SecurityChallengeKind.PerceptionCharacterV3,
            "public.read", "article:42", string.Empty)
        {
            PerceptionCharacterV3 = typed
        };
        var verifyContext = CreateContext(AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(verifyRequest)));
        _ = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            verifyContext, aeds,
            new FixedRiskPolicyProvider(CreatePolicy(PerceptionCharacterV3Contracts.WireName)),
            new RiskControlContextFactory(), orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(), new NullRiskSink(), CancellationToken.None);

        await provider.DidNotReceive().IssueAsync(Arg.Any<SecurityChallengeProviderIssueRequest>(), Arg.Any<CancellationToken>());
        await provider.DidNotReceive().VerifyAsync(Arg.Any<SecurityChallengeProviderVerifyRequest>(), Arg.Any<CancellationToken>());
        await guard.Received(2).IsOpenAsync(Arg.Any<CancellationToken>());

        guard.IsOpenAsync(Arg.Any<CancellationToken>()).Returns(true);
        _ = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            issueContext, aeds, new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(PerceptionCharacterV3Contracts.WireName)),
            new RiskControlContextFactory(), new RiskDecisionService(), orchestrator,
            new NullRiskSink(), CancellationToken.None);
        _ = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            verifyContext, aeds,
            new FixedRiskPolicyProvider(CreatePolicy(PerceptionCharacterV3Contracts.WireName)),
            new RiskControlContextFactory(), orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(), new NullRiskSink(), CancellationToken.None);

        await provider.Received(1).IssueAsync(Arg.Any<SecurityChallengeProviderIssueRequest>(), Arg.Any<CancellationToken>());
        await provider.Received(1).VerifyAsync(Arg.Any<SecurityChallengeProviderVerifyRequest>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(0)]
    [InlineData(3)]
    [InlineData(10)]
    [InlineData(13)]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-raw-kind-generic-error")]
    public async Task VerifyAsync_UnsupportedOrRetiredRawKind_ReturnsSameGenericApiError(int rawKind)
    {
        var aeds = new AedsEncoder();
        var request = CreateVerifyRequest(
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        byte[] encodedRequest = PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request);
        encodedRequest[0] = (byte)rawKind;
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(encodedRequest));

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy("security.pow")),
            new RiskControlContextFactory(),
            new FakeChallengeOrchestrator(),
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("security_challenge_verify_request_invalid", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Theory]
    [InlineData("crypto_failure", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("redis_failure", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("provider_exception", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("provider_missing", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("envelope_state_unavailable", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("assignment_invalid_internal", "rejected", StatusCodes.Status428PreconditionRequired)]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-issue-v3-internal-failure-coarse")]
    public async Task IssueAsync_PerceptionCharacterV3InternalFailureReturnsOnlyCoarseError(string internalReason, string expectedPublicReason, int expectedStatus)
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest(
            "public.read", "article:42", "client-controlled-device", "{}", SecurityChallengeCapabilityCatalog.ManifestVersion);
        var context = CreateContext(AedsFrameType.SecurityChallengeIssueRequest, BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            IssueResult = SecurityChallengeOrchestrationIssueResult.Failed(internalReason)
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(PerceptionCharacterV3Contracts.WireName)),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(expectedStatus, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(expectedPublicReason, error.Message);
        Assert.DoesNotContain(internalReason, error.Details ?? string.Empty, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("")]
    [InlineData("older-build")]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-manifest-missing-incompatible-fail")]
    public async Task IssueAsync_MultiMemberWithMissingOrIncompatibleManifest_FailsBeforeProviderIssue(string manifestVersion)
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest(
            RiskActionNames.PublicRead,
            "article:42",
            "device-123456",
            "{}",
            manifestVersion);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(
                "perceptionLocalizationV2",
                ["perceptionLocalizationV2", Sha256PowChallengeProvider.WireKind])),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status409Conflict, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("security_challenge_client_capability_incompatible", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Null(orchestrator.LastIssueRequest);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task IssueAsync_MultiMemberWithCurrentExecutableManifest_ReachesProviderIssue()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest(
            RiskActionNames.PublicRead,
            "article:42",
            "device-123456",
            "{}",
            SecurityChallengeCapabilityCatalog.ManifestVersion);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator();

        _ = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(
                "perceptionLocalizationV2",
                ["perceptionLocalizationV2", Sha256PowChallengeProvider.WireKind])),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            new NullRiskSink(),
            CancellationToken.None);

        Assert.NotNull(orchestrator.LastIssueRequest);
        Assert.Equal(
            ["perceptionLocalizationV2", Sha256PowChallengeProvider.WireKind],
            orchestrator.LastIssueRequest.Decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-ui-member-unavailable-fail")]
    public async Task IssueAsync_MultiMemberWithUnavailableUiMember_FailsBeforeProviderIssue()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest(
            RiskActionNames.PublicRead,
            "article:42",
            "device-123456",
            "{}",
            SecurityChallengeCapabilityCatalog.ManifestVersion);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(
                "perceptionCharacterV3",
                ["perceptionCharacterV3", "adminPasskeyStepUpV1"])),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.Null(orchestrator.LastIssueRequest);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-pospace-unsupported-reissue")]
    public async Task IssueAsync_PoSpaceUnsupportedAttributes_UsesServerReissueDecisionOverBinaryContract()
    {
        var aeds = new AedsEncoder();
        string originalChallengeId = SecurityChallengeContracts.CreateChallengeId();
        string attributesJson = JsonSerializer.Serialize(new
        {
            unsupportedAssignment = new
            {
                challengeId = originalChallengeId,
                kind = Argon2idPoSpaceV1ChallengeProvider.WireKind,
                action = RiskActionNames.PublicRead,
                routeKey = "article:42",
                reason = "memory_tier_cap",
                reissueCount = 1
            }
        });
        var request = new SecurityChallengeIssueBinaryRequest(
            RiskActionNames.PublicRead,
            "article:42",
            "device-123456",
            attributesJson);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var reissue = new FakePoSpaceUnsupportedReissueService();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy(Argon2idPoSpaceV1ChallengeProvider.WireKind)),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            new FakeChallengeOrchestrator(),
            new NullRiskSink(),
            CancellationToken.None,
            reissue);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeIssueResponse(decoded.Payload, out SecurityChallengeIssueBinaryResponse response));
        Assert.Equal(SecurityChallengeDecisionKind.Allow, response.Decision);
        Assert.Equal(originalChallengeId, reissue.LastRequest?.ChallengeId);
        Assert.Equal("memory_tier_cap", reissue.LastRequest?.Reason);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_AcceptedProviderProof_ReturnsProofTokenFrame()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = CreateVerifyRequest(
            challengeId,
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = CreateCompletedVerifyResult(request, "fcp_token")
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy(Sha256PowChallengeProvider.WireKind)),
            new RiskControlContextFactory(),
            orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.SecurityChallengeVerifyResponse, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyResponse(decoded.Payload, out SecurityChallengeVerifyBinaryResponse response));
        Assert.True(response.Verified);
        Assert.Equal("fcp_token", response.ProofToken);
        Assert.Equal(1_770_000_300_000, response.ExpiresAtUnixMs);
        Assert.NotNull(orchestrator.LastVerifyRequest);
        Assert.Equal(challengeId, orchestrator.LastVerifyRequest.ChallengeId);
        Assert.Equal(Sha256PowChallengeProvider.WireKind, orchestrator.LastVerifyRequest.Kind);
        Assert.Equal("fpow", orchestrator.LastVerifyRequest.ProviderPayload["proof"]);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task VerifyAsync_AcceptedNonFinalMember_ReturnsProgressWithoutProof()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = CreateVerifyRequest(
            challengeId,
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = new SecurityChallengeOrchestrationVerifyResult(
                true,
                "ok",
                request.EnvelopeId,
                request.ChallengeId,
                Sha256PowChallengeProvider.WireKind,
                1,
                2,
                false,
                null,
                null)
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy(Sha256PowChallengeProvider.WireKind)),
            new RiskControlContextFactory(),
            orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.True(PodBinaryCodec.TryDecodeSecurityChallengeVerifyResponse(decoded.Payload, out SecurityChallengeVerifyBinaryResponse response));
        Assert.True(response.Verified);
        Assert.False(response.EnvelopeCompleted);
        Assert.Equal(1, response.CompletedCount);
        Assert.Equal(2, response.MemberCount);
        Assert.Equal(string.Empty, response.ProofToken);
        Assert.Equal(0, response.ExpiresAtUnixMs);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-oversized-provider-payload-reject")]
    public async Task VerifyAsync_ProviderPayloadWithOversizedValue_ReturnsApiErrorWithoutCallingOrchestrator()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string providerPayloadJson = $$"""{"proof":"{{new string('x', 20 * 1024)}}"}""";
        var request = CreateVerifyRequest(
            challengeId,
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            providerPayloadJson);
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = CreateCompletedVerifyResult(request, "fcp_token")
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy(Sha256PowChallengeProvider.WireKind)),
            new RiskControlContextFactory(),
            orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);

        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("security_challenge_payload_invalid", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Equal(0, orchestrator.VerifyCallCount);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Boundary)]
    public void SecurityChallengePayloadParser_EnforcesRuntimeEntryValueAndDepthBounds()
    {
        Type endpointType = typeof(BinaryEndpoints);
        MethodInfo parser = endpointType.GetMethod(
            "TryDeserializeProviderPayload",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Security challenge payload parser was not found.");
        int maxEntries = ReadPrivateConstant<int>(endpointType, "MaxSecurityChallengeProviderPayloadEntries");
        int maxValueChars = ReadPrivateConstant<int>(endpointType, "MaxSecurityChallengeProviderPayloadValueChars");

        IReadOnlyDictionary<string, string> accepted = InvokePayloadParser(
            parser,
            """{"proof":"fpow","nonce":"42"}""",
            expectedAccepted: true);
        Assert.Equal("fpow", accepted["proof"]);
        Assert.Equal("42", accepted["nonce"]);

        string tooManyEntries = "{" + string.Join(",", Enumerable.Range(0, maxEntries + 1)
            .Select(static index => $"\"k{index}\":\"v\"")) + "}";
        Assert.Empty(InvokePayloadParser(parser, tooManyEntries, expectedAccepted: false));
        Assert.Empty(InvokePayloadParser(
            parser,
            $$"""{"proof":"{{new string('x', maxValueChars + 1)}}"}""",
            expectedAccepted: false));
        Assert.Empty(InvokePayloadParser(parser, """{"proof":{"nested":"value"}}""", expectedAccepted: false));
        Assert.Empty(InvokePayloadParser(parser, """{"proof":"fpow"} trailing""", expectedAccepted: false));

        FieldInfo cacheOptionsField = typeof(AdminPrincipalService).GetField(
            "s_challengeCacheJsonOptions",
            BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException("Admin challenge cache serializer options were not found.");
        JsonSerializerOptions cacheOptions = Assert.IsType<JsonSerializerOptions>(cacheOptionsField.GetValue(null));
        Assert.Equal(32, cacheOptions.MaxDepth);
        Assert.NotNull(cacheOptions.PropertyNamingPolicy);
    }

    [Theory]
    [InlineData("perception_text_answer_invalid")]
    [InlineData("perception_coordinate_invalid")]
    [InlineData("perception_steps_invalid")]
    [InlineData("perception_expired")]
    [InlineData("perception_replayed")]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-provider-failure-generic-error")]
    public async Task VerifyAsync_ProviderFailure_ReturnsGenericChallengeFailedApiError(string internalReason)
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = CreateVerifyRequest(
            challengeId,
            SecurityChallengeKind.PerceptionLocalizationV2,
            "auth.login",
            "auth.login",
            """{"step":"wrong","solveDurationMs":"2400"}""");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = SecurityChallengeOrchestrationVerifyResult.Failed(internalReason)
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy("perceptionLocalizationV2")),
            new RiskControlContextFactory(),
            orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.Forbidden, error.Code);
        Assert.Equal("challenge_failed", error.Message);
        Assert.DoesNotContain(internalReason, error.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(internalReason, error.Details ?? string.Empty, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("provider_exception", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("provider_missing", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("state_unavailable", "unavailable", StatusCodes.Status503ServiceUnavailable)]
    [InlineData("token_open_failed_internal", "rejected", StatusCodes.Status428PreconditionRequired)]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-verify-v3-internal-failure-coarse")]
    public async Task VerifyAsync_PerceptionCharacterV3InternalFailureReturnsOnlyCoarseError(string internalReason, string expectedPublicReason, int expectedStatus)
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        var typed = new PerceptionCharacterV3VerifyPayload(PerceptionCharacterV3Contracts.Algorithm, challengeId, envelopeId, PerceptionCharacterV3Representation.Visual, "A7C9Q", "opaque-state");
        var request = new SecurityChallengeVerifyBinaryRequest(envelopeId, challengeId, SecurityChallengeKind.PerceptionCharacterV3, "public.read", "article:42", string.Empty)
        {
            PerceptionCharacterV3 = typed
        };
        var context = CreateContext(AedsFrameType.SecurityChallengeVerifyRequest, BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = SecurityChallengeOrchestrationVerifyResult.Failed(internalReason)
        };

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy(PerceptionCharacterV3Contracts.WireName)),
            new RiskControlContextFactory(),
            orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(expectedStatus, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(expectedPublicReason, error.Message);
        Assert.DoesNotContain(internalReason, error.Details ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-composite-failure-max-attempts")]
    public async Task VerifyAsync_RepeatedCompositeFailures_ReturnGenericFailureWithoutCallingOrchestratorAfterMaxAttempts()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = CreateVerifyRequest(
            challengeId,
            SecurityChallengeKind.PerceptionLocalizationV2,
            "auth.login",
            "auth.login",
            """{"step":"wrong","solveDurationMs":"2400"}""");
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = SecurityChallengeOrchestrationVerifyResult.Failed("perception_text_answer_invalid")
        };
        var riskSink = new CapturingRiskSink();
        var verifyRateLimiter = new CountingSecurityChallengeVerifyRateLimiter(SecurityChallengeVerifyDefaultMaxAttempts);

        for (int i = 0; i < SecurityChallengeVerifyDefaultMaxAttempts + 1; i++)
        {
            var context = CreateContext(
                AedsFrameType.SecurityChallengeVerifyRequest,
                BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));

            BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
                context,
                aeds,
                new FixedRiskPolicyProvider(CreatePolicy("perceptionLocalizationV2")),
                new RiskControlContextFactory(),
                orchestrator,
                verifyRateLimiter,
                riskSink,
                CancellationToken.None);

            AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
            Assert.Equal(StatusCodes.Status428PreconditionRequired, context.Response.StatusCode);
            Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
            Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
            Assert.Equal("challenge_failed", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        }

        Assert.Equal(SecurityChallengeVerifyDefaultMaxAttempts, orchestrator.VerifyCallCount);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal("auth.login", signal.Action);
        Assert.Equal("challenge_verify_rate_limited", signal.Detail);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-rate-limited-malformed-payload")]
    public async Task VerifyAsync_RateLimitedMalformedProviderPayload_ReturnsGenericFailureWithoutCallingOrchestrator()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = CreateVerifyRequest(
            challengeId,
            SecurityChallengeKind.PerceptionLocalizationV2,
            "auth.login",
            "auth.login",
            """{"step":""");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = CreateCompletedVerifyResult(request, "should_not_run")
        };
        var riskSink = new CapturingRiskSink();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy("perceptionLocalizationV2")),
            new RiskControlContextFactory(),
            orchestrator,
            new CountingSecurityChallengeVerifyRateLimiter(maxAttempts: 0),
            riskSink,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);

        Assert.Equal(StatusCodes.Status428PreconditionRequired, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("challenge_failed", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Equal(0, orchestrator.VerifyCallCount);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal("challenge_verify_rate_limited", signal.Detail);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task CancelAsync_RevokesEnvelopeAndEveryPersistedMemberIdempotently()
    {
        var aeds = new AedsEncoder();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeCancelBinaryRequest(
            envelopeId,
            "public.read",
            "article:42",
            "device-123456",
            "risk-policy-v2");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeCancelRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request)));
        var stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        string firstId = SecurityChallengeContracts.CreateChallengeId();
        string secondId = SecurityChallengeContracts.CreateChallengeId();
        stateService.GetAsync(envelopeId, Arg.Any<CancellationToken>()).Returns(new SecurityChallengeEnvelopeState(
            envelopeId,
            request.Action,
            request.RouteKey,
            HashA,
            HashB,
            HashC,
            request.PolicyVersion,
            [firstId, secondId],
            ["perceptionLocalizationV2", "sha256PowV1"],
            [SecurityChallengeEnvelopeMemberStatuses.Issued, SecurityChallengeEnvelopeMemberStatuses.Verified],
            DateTimeOffset.UtcNow.AddMinutes(-1).ToUnixTimeMilliseconds(),
            DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds(),
            SecurityChallengeEnvelopeStatuses.Active,
            0));
        stateService.RevokeAsync(
            Arg.Any<SecurityChallengeEnvelopeBindingRequest>(),
            "client_cancelled",
            Arg.Any<CancellationToken>()).Returns(true);
        var persistence = Substitute.For<ISecurityChallengePersistenceService>();
        persistence.RevokeAsync(Arg.Any<string>(), Arg.Any<string?>(), Arg.Any<CancellationToken>()).Returns(true);

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeCancelAsync(
            context,
            aeds,
            new RiskControlContextFactory(),
            stateService,
            persistence,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.EmptySuccess, decoded.FrameType);
        await stateService.Received(1).RevokeAsync(
            Arg.Is<SecurityChallengeEnvelopeBindingRequest>(binding =>
                binding.EnvelopeId == envelopeId
                && binding.Action == request.Action
                && binding.RouteKey == request.RouteKey
                && binding.PolicyVersion == request.PolicyVersion),
            "client_cancelled",
            Arg.Any<CancellationToken>());
        await persistence.Received(1).RevokeAsync(firstId, "envelope_client_cancelled", Arg.Any<CancellationToken>());
        await persistence.Received(1).RevokeAsync(secondId, "envelope_client_cancelled", Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-cancel-unbound-members-unchanged")]
    public async Task CancelAsync_BindingMissReturnsOpaqueSuccessWithoutTouchingMembers()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeCancelBinaryRequest(
            SecurityChallengeContracts.CreateChallengeId(),
            "public.read",
            "article:42",
            "device-123456",
            "risk-policy-v2");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeCancelRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request)));
        var stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        var persistence = Substitute.For<ISecurityChallengePersistenceService>();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeCancelAsync(
            context,
            aeds,
            new RiskControlContextFactory(),
            stateService,
            persistence,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.EmptySuccess, decoded.FrameType);
        await persistence.DidNotReceive().RevokeAsync(
            Arg.Any<string>(),
            Arg.Any<string?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task CancelAsync_PlannedV3RevokesEnvelopeWithoutRequiringUnissuedProviderState()
    {
        var aeds = new AedsEncoder();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        string powId = SecurityChallengeContracts.CreateChallengeId();
        string v3Id = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeCancelBinaryRequest(envelopeId, "public.read", "article:42", "device", "policy");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeCancelRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request)));
        var stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        stateService.GetAsync(envelopeId, Arg.Any<CancellationToken>()).Returns(new SecurityChallengeEnvelopeState(
            envelopeId, request.Action, request.RouteKey, HashA, HashB, HashC, request.PolicyVersion,
            [powId, v3Id], ["sha256PowV1", PerceptionCharacterV3Contracts.WireName],
            [SecurityChallengeEnvelopeMemberStatuses.Issued, SecurityChallengeEnvelopeMemberStatuses.Planned],
            1, 2, SecurityChallengeEnvelopeStatuses.Active, 0));
        stateService.RevokeAsync(
            Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), "client_cancelled", Arg.Any<CancellationToken>()).Returns(true);
        var persistence = Substitute.For<ISecurityChallengePersistenceService>();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeCancelAsync(
            context, aeds, new RiskControlContextFactory(), stateService, persistence, CancellationToken.None);

        Assert.Equal(AedsFrameType.EmptySuccess, (await ExecuteAndDecodeAsync(result, context, aeds)).FrameType);
        await stateService.Received(1).RevokeAsync(
            Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), "client_cancelled", Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-cancel-v3-disabled-fail-closed")]
    public async Task CancelAsync_PerceptionCharacterV3DisabledServicesFailClosedWithoutBreakingRoute()
    {
        var aeds = new AedsEncoder();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeCancelBinaryRequest(envelopeId, "public.read", "article:42", "device", "policy");
        var context = CreateContext(AedsFrameType.SecurityChallengeCancelRequest, BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request)));
        var stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        stateService.GetAsync(envelopeId, Arg.Any<CancellationToken>()).Returns(new SecurityChallengeEnvelopeState(
            envelopeId, request.Action, request.RouteKey, HashA, HashB, HashC, "issued-policy", [challengeId], [PerceptionCharacterV3Contracts.WireName], [SecurityChallengeEnvelopeMemberStatuses.Issued], 1, 2, SecurityChallengeEnvelopeStatuses.Active, 0));
        var persistence = Substitute.For<ISecurityChallengePersistenceService>();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeCancelAsync(
            context, aeds, new RiskControlContextFactory(), stateService, persistence, CancellationToken.None,
            Substitute.For<IPerceptionCharacterV3StateStore>());

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("unavailable", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        await stateService.DidNotReceive().RevokeAsync(Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData(PerceptionCharacterV3TransitionKind.ReissueRequired, "revoked_now", "revoked", true)]
    [InlineData(PerceptionCharacterV3TransitionKind.ReissueRequired, "expired_or_revoked", "terminal", true)]
    [InlineData(PerceptionCharacterV3TransitionKind.Rejected, "binding_mismatch", "rejected", false)]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task CancelAsync_PerceptionCharacterV3RequiresCurrentServerDeviceAndAuditsSpecificOutcome(
        PerceptionCharacterV3TransitionKind transitionKind,
        string internalReason,
        string expectedAuditOutcome,
        bool expectedEnvelopeRevocation)
    {
        var aeds = new AedsEncoder();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeCancelBinaryRequest(envelopeId, "public.read", "article:42", "rotated-client-device", "newly-published-policy");
        var context = CreateContext(AedsFrameType.SecurityChallengeCancelRequest, BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request)));
        context.Request.Headers["X-Fsus-Device-Fp"] = "another-rotated-client-device";
        byte[] answerKey = Enumerable.Repeat((byte)0x44, 32).ToArray();
        string serverDeviceBinding = PerceptionCharacterV3Crypto.DeriveDeviceBinding(answerKey, "session:current-device");
        string storedDeviceBinding = transitionKind == PerceptionCharacterV3TransitionKind.Rejected
            ? PerceptionCharacterV3Crypto.DeriveDeviceBinding(answerKey, "session:issued-device")
            : serverDeviceBinding;
        var stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        stateService.GetAsync(envelopeId, Arg.Any<CancellationToken>()).Returns(new SecurityChallengeEnvelopeState(
            envelopeId, request.Action, request.RouteKey, HashA, HashB, HashC, "issued-policy", [challengeId], [PerceptionCharacterV3Contracts.WireName], [SecurityChallengeEnvelopeMemberStatuses.Issued], 1, 2, SecurityChallengeEnvelopeStatuses.Active, 0));
        stateService.RevokeAsync(Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), "client_cancelled", Arg.Any<CancellationToken>()).Returns(true);
        var persistence = Substitute.For<ISecurityChallengePersistenceService>();
        persistence.RevokeAsync(challengeId, Arg.Any<string?>(), Arg.Any<CancellationToken>()).Returns(true);
        var v3Store = Substitute.For<IPerceptionCharacterV3StateStore>();
        v3Store.ReadAsync(challengeId, Arg.Any<CancellationToken>()).Returns(new PerceptionCharacterV3StateRecord(
            challengeId, envelopeId, request.Action, request.RouteKey, HashA, storedDeviceBinding, HashA, HashB,
            "issued-policy", HashC, "visual", PerceptionCharacterV3Contracts.VisualMediaType, 384, 144, 320, 120,
            1, 2, "tk", "ak", HashA));
        v3Store.RevokeAsync(Arg.Any<PerceptionCharacterV3StateRecord>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(new PerceptionCharacterV3Transition(transitionKind, internalReason, 0));
        var deviceAuthority = Substitute.For<IPerceptionCharacterV3DeviceAuthority>();
        deviceAuthority.ResolveAsync(context, Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(PerceptionCharacterV3DeviceAuthorityResult.Success("session:current-device"));
        var audit = new CapturingPerceptionV3Audit();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeCancelAsync(
            context, aeds, new RiskControlContextFactory(), stateService, persistence, CancellationToken.None,
            v3Store, deviceAuthority, new FixedPerceptionV3Keys(answerKey), audit);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.EmptySuccess, decoded.FrameType);
        Assert.Contains(audit.Events, entry => entry == ("cancel", expectedAuditOutcome, internalReason));
        await v3Store.Received(1).RevokeAsync(
            Arg.Is<PerceptionCharacterV3StateRecord>(record => record.DeviceBindingHash == serverDeviceBinding && record.PolicyVersion == "issued-policy"),
            Arg.Any<long>(), Arg.Any<CancellationToken>());
        if (expectedEnvelopeRevocation)
            await stateService.Received(1).RevokeAsync(Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), "client_cancelled", Arg.Any<CancellationToken>());
        else
            await stateService.DidNotReceive().RevokeAsync(Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-cancel-redis-failure-unavailable")]
    public async Task CancelAsync_PerceptionCharacterV3RedisFailureReturnsOnlyUnavailableAndAuditsReason()
    {
        var aeds = new AedsEncoder();
        string envelopeId = SecurityChallengeContracts.CreateChallengeId();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeCancelBinaryRequest(envelopeId, "public.read", "article:42", "device", "policy");
        var context = CreateContext(AedsFrameType.SecurityChallengeCancelRequest, BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeCancelRequest(request)));
        byte[] answerKey = Enumerable.Repeat((byte)0x45, 32).ToArray();
        var stateService = Substitute.For<ISecurityChallengeEnvelopeStateService>();
        stateService.GetAsync(envelopeId, Arg.Any<CancellationToken>()).Returns(new SecurityChallengeEnvelopeState(
            envelopeId, request.Action, request.RouteKey, HashA, HashB, HashC, "issued-policy", [challengeId], [PerceptionCharacterV3Contracts.WireName], [SecurityChallengeEnvelopeMemberStatuses.Issued], 1, 2, SecurityChallengeEnvelopeStatuses.Active, 0));
        var persistence = Substitute.For<ISecurityChallengePersistenceService>();
        var v3Store = Substitute.For<IPerceptionCharacterV3StateStore>();
        v3Store.ReadAsync(challengeId, Arg.Any<CancellationToken>())
            .Returns<Task<PerceptionCharacterV3StateRecord?>>(_ => throw new PerceptionCharacterV3StoreUnavailableException(new InvalidOperationException("redis secret")));
        var deviceAuthority = Substitute.For<IPerceptionCharacterV3DeviceAuthority>();
        deviceAuthority.ResolveAsync(context, Arg.Any<string>(), Arg.Any<CancellationToken>())
            .Returns(PerceptionCharacterV3DeviceAuthorityResult.Success("session:current-device"));
        var audit = new CapturingPerceptionV3Audit();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeCancelAsync(
            context, aeds, new RiskControlContextFactory(), stateService, persistence, CancellationToken.None,
            v3Store, deviceAuthority, new FixedPerceptionV3Keys(answerKey), audit);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, context.Response.StatusCode);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("unavailable", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Contains(audit.Events, entry => entry == ("cancel", "unavailable", "redis_unavailable"));
        await stateService.DidNotReceive().RevokeAsync(Arg.Any<SecurityChallengeEnvelopeBindingRequest>(), Arg.Any<string>(), Arg.Any<CancellationToken>());
    }

    [Theory]
    [InlineData("incompatible-media-type", "application/json")]
    [InlineData("binary-q-zero", "application/octet-stream;q=0")]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-unacceptable-accept-406")]
    public async Task IssueAsync_UnacceptableAcceptHeader_ReturnsApiError406(
        string caseName,
        string acceptHeader)
    {
        var aeds = new AedsEncoder();
        var context = CreateContext(AedsFrameType.SecurityChallengeIssueRequest, BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "should_not_read")));
        context.Request.Headers.Accept = acceptHeader;
        var requestContext = Substitute.For<IBinaryEndpointRequestContext>();
        requestContext.ReadFrameAsync(
                Arg.Any<HttpContext>(),
                Arg.Any<IAedsEncoder>(),
                Arg.Any<AedsFrameType>(),
                Arg.Any<CancellationToken>(),
                Arg.Any<int?>())
            .Returns(BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "should_not_read")));
        context.RequestServices = new ServiceCollection()
            .AddSingleton(requestContext)
            .BuildServiceProvider();
        var riskScoreReader = Substitute.For<ISecurityRiskScoreReader>();
        var riskPolicyProvider = Substitute.For<ISecurityRiskPolicyProvider>();
        var riskContextFactory = Substitute.For<IRiskControlContextFactory>();
        var riskDecisionService = Substitute.For<IRiskDecisionService>();
        var challengeOrchestrator = Substitute.For<ISecurityChallengeOrchestrator>();
        var riskSink = Substitute.For<ISecurityRiskSignalSink>();
        var poSpaceUnsupportedReissueService = Substitute.For<IPoSpaceUnsupportedReissueService>();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            riskScoreReader,
            riskPolicyProvider,
            riskContextFactory,
            riskDecisionService,
            challengeOrchestrator,
            riskSink,
            CancellationToken.None,
            poSpaceUnsupportedReissueService);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod), caseName);
        Assert.Equal(StatusCodes.Status406NotAcceptable, errorPod.HttpStatus);
        ErrorDetail error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorDetail.Create(ErrorCode.Validation, "binary_accept_required"), error);
        Assert.DoesNotContain("should_not_read", error.Message, StringComparison.Ordinal);
        Assert.Empty(requestContext.ReceivedCalls());
        Assert.Empty(riskScoreReader.ReceivedCalls());
        Assert.Empty(riskPolicyProvider.ReceivedCalls());
        Assert.Empty(riskContextFactory.ReceivedCalls());
        Assert.Empty(riskDecisionService.ReceivedCalls());
        Assert.Empty(challengeOrchestrator.ReceivedCalls());
        Assert.Empty(riskSink.ReceivedCalls());
        Assert.Empty(poSpaceUnsupportedReissueService.ReceivedCalls());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-incompatible-content-type-error")]
    public async Task IssueAsync_IncompatibleContentType_ReturnsApiError()
    {
        var aeds = new AedsEncoder();
        var context = CreateContextWithRealBinder("application/json");

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy("security.pow")),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            new FakeChallengeOrchestrator(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Contains("application/octet-stream", PodBinaryCodec.ToErrorDetail(errorPod).Message, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-missing-action-route-error")]
    public async Task IssueAsync_MissingActionOrRoute_ReturnsApiError()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest("", "", "device-123456", "{}");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy("security.pow")),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            new FakeChallengeOrchestrator(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("security_challenge_action_route_required", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Theory]
    [InlineData((byte)3)]
    [InlineData((byte)10)]
    [InlineData((byte)13)]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "challenge-retired-raw-kind-generic-invalid")]
    public async Task VerifyAsync_RetiredRawKindByteThroughAedsFrame_ReturnsGenericInvalidRequestWithoutCallingOrchestrator(
        byte retiredRawKind)
    {
        var aeds = new AedsEncoder();
        var request = CreateVerifyRequest(
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Sha256PowV1,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        byte[] encodedRequest = PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request);
        encodedRequest[0] = retiredRawKind;
        byte[] requestFrame = aeds.Encode(AedsFrameType.SecurityChallengeVerifyRequest, encodedRequest);
        var context = CreateContextWithRealBinder("application/octet-stream", requestFrame);
        var orchestrator = new FakeChallengeOrchestrator();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy("security.pow")),
            new RiskControlContextFactory(),
            orchestrator,
            new AllowingSecurityChallengeVerifyRateLimiter(),
            new NullRiskSink(),
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("security_challenge_verify_request_invalid", PodBinaryCodec.ToErrorDetail(errorPod).Message);
        Assert.Equal(0, orchestrator.VerifyCallCount);
        BinaryRequestBufferLeaseScope.Release(context, "unit-test");
    }

    private static SecurityChallengeVerifyBinaryRequest CreateVerifyRequest(
        string challengeId,
        SecurityChallengeKind kind,
        string action,
        string routeKey,
        string providerPayloadJson)
        => new(
            SecurityChallengeContracts.CreateChallengeId(),
            challengeId,
            kind,
            action,
            routeKey,
            providerPayloadJson);

    private static SecurityChallengeOrchestrationVerifyResult CreateCompletedVerifyResult(
        SecurityChallengeVerifyBinaryRequest request,
        string proofToken)
        => new(
            true,
            "ok",
            request.EnvelopeId,
            request.ChallengeId,
            SecurityChallengeContracts.ToWireName(request.Kind),
            1,
            1,
            true,
            proofToken,
            DateTimeOffset.FromUnixTimeMilliseconds(1_770_000_300_000));

    private static DefaultHttpContext CreateContext(AedsFrameType expectedFrameType, BinaryRequestPayload payload)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-unit";
        context.Request.Headers.Accept = "application/octet-stream";
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        context.Request.Headers["X-Fsus-Device-Fp"] = "device-123456";
        context.Request.Headers["traceparent"] = Traceparent;

        var requestContext = new FakeBinaryEndpointRequestContext(expectedFrameType, payload);
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IBinaryEndpointRequestContext>(requestContext)
            .BuildServiceProvider();
        return context;
    }

    private static DefaultHttpContext CreateContextWithRealBinder(string contentType, byte[]? requestFrame = null)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Body = new MemoryStream(requestFrame ?? []);
        context.Request.ContentType = contentType;
        if (requestFrame is not null)
        {
            context.Request.ContentLength = requestFrame.Length;
        }
        context.Request.Headers.Accept = "application/octet-stream";
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        context.Request.Headers["X-Fsus-Device-Fp"] = "device-123456";
        context.Request.Headers["traceparent"] = Traceparent;
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.TraceIdentifier = "trace-unit";

        context.RequestServices = new ServiceCollection()
            .AddSingleton<IHotArticlesCacheVersionProvider>(new FixedHotArticlesCacheVersionProvider())
            .AddSingleton<IBinaryRequestBinder, BinaryRequestBinder>()
            .AddSingleton<IBinaryEndpointRequestContext, BinaryEndpointRequestContext>()
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

    private static SecurityChallengeAssignment CreateAssignment(SecurityChallengeKind kind = SecurityChallengeKind.Sha256PowV1)
        => new(
            SecurityChallengeContracts.CreateChallengeId(),
            Traceparent,
            "tenant-main",
            kind,
            1,
            "public.read",
            "article:42",
            HashA,
            HashB,
            HashC,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds());

    private static T ReadPrivateConstant<T>(Type type, string fieldName)
    {
        FieldInfo field = type.GetField(fieldName, BindingFlags.NonPublic | BindingFlags.Static)
            ?? throw new InvalidOperationException($"Missing runtime limit: {fieldName}");
        Assert.True(field.IsLiteral);
        return Assert.IsType<T>(field.GetRawConstantValue());
    }

    private static IReadOnlyDictionary<string, string> InvokePayloadParser(
        MethodInfo parser,
        string json,
        bool expectedAccepted)
    {
        object?[] arguments = [json, null];
        bool accepted = Assert.IsType<bool>(parser.Invoke(null, arguments));
        Assert.Equal(expectedAccepted, accepted);
        return Assert.IsAssignableFrom<IReadOnlyDictionary<string, string>>(arguments[1]);
    }

    private static SecurityRiskPolicy CreatePolicy(
        string challengeKind,
        IReadOnlyList<string>? requiredChallenges = null)
    {
        bool aggregate = requiredChallenges is { Count: > 1 };
        var defaultPolicy = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, aggregate ? 50 : 100, 100, 100),
            challengeKind,
            1,
            null,
            AnonymousWriteAllowed: false)
        {
            HardChallengeKinds = requiredChallenges ?? []
        };
        return new SecurityRiskPolicy(
            "risk:test",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk:lkg",
            defaultPolicy,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.PublicRead] = defaultPolicy with
                {
                    ActionName = RiskActionNames.PublicRead,
                    AnonymousWriteAllowed = true
                }
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce
            });
    }

    private sealed class FixedRiskScoreReader(int riskScore) : ISecurityRiskScoreReader
    {
        public Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.FromResult(riskScore);

        public Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(riskScore);

        public Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicy policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicy CurrentRiskPolicy => policy;
    }

    private sealed class NullRiskSink : ISecurityRiskSignalSink
    {
        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;
    }

    private sealed class FixedPerceptionV3Keys(byte[] answerKey) : IPerceptionCharacterV3KeyRing
    {
        public string CurrentTokenVersion => "tk";
        public string CurrentAnswerVersion => "ak";
        public bool TryGetTokenKey(string version, out byte[] key)
        {
            key = [];
            return false;
        }
        public bool TryGetAnswerKey(string version, out byte[] key)
        {
            key = answerKey;
            return version == "ak";
        }
    }

    private sealed class CapturingPerceptionV3Audit : IPerceptionCharacterV3AuditSink
    {
        public List<(string Operation, string Outcome, string Reason)> Events { get; } = [];
        public ValueTask WriteAsync(string operation, string challengeId, string action, string outcome, string internalReason, CancellationToken cancellationToken)
        {
            Events.Add((operation, outcome, internalReason));
            return ValueTask.CompletedTask;
        }
    }

    private sealed class FakePoSpaceUnsupportedReissueService : IPoSpaceUnsupportedReissueService
    {
        public PoSpaceUnsupportedReissueRequest? LastRequest
        {
            get; private set;
        }

        public Task<PoSpaceUnsupportedReissueResult> ReissueAsync(
            PoSpaceUnsupportedReissueRequest request,
            RiskDecision currentDecision,
            SecurityRiskPolicy currentPolicy,
            CancellationToken cancellationToken = default)
        {
            LastRequest = request;
            RiskDecision replacement = currentDecision with
            {
                Kind = RiskDecisionKind.Allow,
                RequiredChallenges = [],
                Reasons = [.. currentDecision.Reasons, "pospace_unsupported_current_policy"]
            };
            return Task.FromResult(PoSpaceUnsupportedReissueResult.Success(replacement, "pospace_unsupported_policy_changed"));
        }
    }

    private sealed class CapturingRiskSink : ISecurityRiskSignalSink
    {
        public List<SecurityRiskSignal> Signals { get; } = [];

        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
        {
            Signals.Add(signal);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class AllowingSecurityChallengeVerifyRateLimiter : ISecurityChallengeVerifyRateLimiter
    {
        public Task<bool> TryAcquireAsync(HttpContext httpContext, string challengeId, string action, CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class CountingSecurityChallengeVerifyRateLimiter(int maxAttempts) : ISecurityChallengeVerifyRateLimiter
    {
        private int _attempts;

        public Task<bool> TryAcquireAsync(HttpContext httpContext, string challengeId, string action, CancellationToken cancellationToken = default)
            => Task.FromResult(Interlocked.Increment(ref _attempts) <= maxAttempts);
    }

    private sealed class FixedHotArticlesCacheVersionProvider : IHotArticlesCacheVersionProvider
    {
        public long CurrentHotArticlesVersion => 1;

        public string BuildVersionedHotArticlesIdentity(string identity)
            => $"hot:1:{identity}";
    }

    private sealed class FakeChallengeOrchestrator : ISecurityChallengeOrchestrator
    {
        public SecurityChallengeOrchestrationIssueRequest? LastIssueRequest
        {
            get; private set;
        }

        public SecurityChallengeOrchestrationVerifyRequest? LastVerifyRequest
        {
            get; private set;
        }

        public int VerifyCallCount
        {
            get; private set;
        }

        public SecurityChallengeOrchestrationIssueResult IssueResult { get; set; } = SecurityChallengeOrchestrationIssueResult.Failed("provider_missing");

        public SecurityChallengeOrchestrationVerifyResult VerifyResult { get; set; } = SecurityChallengeOrchestrationVerifyResult.Failed("provider_missing");

        public Task<SecurityChallengeOrchestrationIssueResult> IssueAsync(SecurityChallengeOrchestrationIssueRequest request, CancellationToken cancellationToken = default)
        {
            LastIssueRequest = request;
            return Task.FromResult(IssueResult);
        }

        public Task<SecurityChallengeOrchestrationVerifyResult> VerifyAsync(SecurityChallengeOrchestrationVerifyRequest request, CancellationToken cancellationToken = default)
        {
            LastVerifyRequest = request;
            VerifyCallCount++;
            return Task.FromResult(VerifyResult);
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

        public ValueTask<long> GetArticleListCacheVersionAsync(ICacheStringReader cache)
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
