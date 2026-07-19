using System.Net;
using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityChallengeBinaryEndpointTests
{
    private const int SecurityChallengeVerifyDefaultMaxAttempts = 3;
    private const string HashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string HashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string HashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    private const string Traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

    [Fact]
    public async Task IssueAsync_ChallengeDecision_ReturnsChallengeResponseFrame()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest("public.read", "article:42", "device-123456", "{}");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator();
        SecurityChallengeAssignment assignment = CreateAssignment();
        orchestrator.IssueResult = SecurityChallengeOrchestrationIssueResult.Success(
            new SecurityChallengeEnvelope(SecurityChallengeContracts.CreateChallengeId(), SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion, [assignment]),
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
            new FixedRiskPolicyProvider(CreatePolicy("security.pow")),
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
        Assert.Equal("security.pow", orchestrator.LastIssueRequest.Decision.RequiredChallenges[0]);
        Assert.Matches("^[0-9a-f]{64}$", orchestrator.LastIssueRequest.SubjectHash);
    }

    [Fact]
    public async Task IssueAsync_CaptchaChallengeDecision_WritesCaptchaRequiredRiskSignal()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeIssueBinaryRequest("auth.login", "auth.login", "device-123456", "{}");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeIssueRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeIssueRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator();
        SecurityChallengeAssignment assignment = CreateAssignment(SecurityChallengeKind.CaptchaV1) with
        {
            Action = RiskActionNames.AuthLogin,
            RouteKey = "auth.login"
        };
        orchestrator.IssueResult = SecurityChallengeOrchestrationIssueResult.Success(
            new SecurityChallengeEnvelope(SecurityChallengeContracts.CreateChallengeId(), SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion, [assignment]));
        var riskSink = new CapturingRiskSink();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeIssueAsync(
            context,
            aeds,
            new FixedRiskScoreReader(50),
            new FixedRiskPolicyProvider(CreatePolicy("captchaV1")),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            orchestrator,
            riskSink,
            CancellationToken.None);

        AedsDecodeResult decoded = await ExecuteAndDecodeAsync(result, context, aeds);
        Assert.Equal(AedsFrameType.SecurityChallengeIssueResponse, decoded.FrameType);
        SecurityRiskSignal signal = Assert.Single(riskSink.Signals);
        Assert.Equal(SecurityRiskReason.CaptchaChallengeRequired, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal(RiskActionNames.AuthLogin, signal.Action);
        Assert.Equal("captchaV1", signal.Detail);
        Assert.NotNull(orchestrator.LastIssueRequest);
        Assert.Equal(["captchaV1"], orchestrator.LastIssueRequest.Decision.RequiredChallenges);
    }

    [Fact]
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
    public async Task VerifyAsync_AcceptedProviderProof_ReturnsProofTokenFrame()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeVerifyBinaryRequest(
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
            VerifyResult = new SecurityChallengeOrchestrationVerifyResult(true, "ok", "fcp_token", DateTimeOffset.FromUnixTimeMilliseconds(1_770_000_300_000))
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
    public async Task VerifyAsync_ProviderPayloadWithOversizedValue_ReturnsApiErrorWithoutCallingOrchestrator()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        string providerPayloadJson = $$"""{"proof":"{{new string('x', 20 * 1024)}}"}""";
        var request = new SecurityChallengeVerifyBinaryRequest(
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
            VerifyResult = new SecurityChallengeOrchestrationVerifyResult(true, "ok", "fcp_token", DateTimeOffset.FromUnixTimeMilliseconds(1_770_000_300_000))
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
    public async Task VerifyAsync_ProviderFailure_ReturnsGenericChallengeFailedApiError(string internalReason)
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeVerifyBinaryRequest(
            challengeId,
            SecurityChallengeKind.PerceptionCharacterV2,
            "auth.login",
            "auth.login",
            """{"answerText":"wrong","solveDurationMs":"2400"}""");
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
            new FixedRiskPolicyProvider(CreatePolicy("perceptionCharacterV2")),
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

    [Fact]
    public async Task VerifyAsync_RepeatedCompositeFailures_ReturnGenericFailureWithoutCallingOrchestratorAfterMaxAttempts()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeVerifyBinaryRequest(
            challengeId,
            SecurityChallengeKind.PerceptionCharacterV2,
            "auth.login",
            "auth.login",
            """{"answerText":"wrong","solveDurationMs":"2400"}""");
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
                new FixedRiskPolicyProvider(CreatePolicy("perceptionCharacterV2")),
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
    public async Task VerifyAsync_RateLimitedMalformedProviderPayload_ReturnsGenericFailureWithoutCallingOrchestrator()
    {
        var aeds = new AedsEncoder();
        string challengeId = SecurityChallengeContracts.CreateChallengeId();
        var request = new SecurityChallengeVerifyBinaryRequest(
            challengeId,
            SecurityChallengeKind.PerceptionCharacterV2,
            "auth.login",
            "auth.login",
            """{"answerText":""");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));
        var orchestrator = new FakeChallengeOrchestrator
        {
            VerifyResult = new SecurityChallengeOrchestrationVerifyResult(true, "ok", "should_not_run", DateTimeOffset.FromUnixTimeMilliseconds(1_770_000_300_000))
        };
        var riskSink = new CapturingRiskSink();

        BinaryFrameResult result = await BinaryEndpoints.HandleSecurityChallengeVerifyAsync(
            context,
            aeds,
            new FixedRiskPolicyProvider(CreatePolicy("perceptionCharacterV2")),
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
    public async Task IssueAsync_IncompatibleAccept_ReturnsApiError406()
    {
        var aeds = new AedsEncoder();
        var context = CreateContext(AedsFrameType.SecurityChallengeIssueRequest, BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "should_not_read")));
        context.Request.Headers.Accept = "application/json";

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
        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
    }

    [Fact]
    public async Task IssueAsync_BinaryAcceptWithZeroQuality_ReturnsApiError406()
    {
        var aeds = new AedsEncoder();
        var context = CreateContext(AedsFrameType.SecurityChallengeIssueRequest, BinaryRequestPayload.Failure(ErrorDetail.Create(ErrorCode.Validation, "should_not_read")));
        context.Request.Headers.Accept = "application/octet-stream;q=0";

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
        Assert.Equal(StatusCodes.Status406NotAcceptable, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
    }

    [Fact]
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

    [Fact]
    public async Task VerifyAsync_UnsupportedKind_ReturnsApiError()
    {
        var aeds = new AedsEncoder();
        var request = new SecurityChallengeVerifyBinaryRequest(
            SecurityChallengeContracts.CreateChallengeId(),
            SecurityChallengeKind.Unknown,
            "public.read",
            "article:42",
            """{"proof":"fpow"}""");
        var context = CreateContext(
            AedsFrameType.SecurityChallengeVerifyRequest,
            BinaryRequestPayload.Success(PodBinaryCodec.EncodeSecurityChallengeVerifyRequest(request)));

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
        Assert.Equal("security_challenge_kind_unsupported", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

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

    private static DefaultHttpContext CreateContextWithRealBinder(string contentType)
    {
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Body = new MemoryStream();
        context.Request.ContentType = contentType;
        context.Request.Headers.Accept = "application/octet-stream";
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

    private static SecurityRiskPolicySnapshotV2 CreatePolicy(string challengeKind)
    {
        var defaultPolicy = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
            challengeKind,
            1,
            null,
            AnonymousWriteAllowed: false);
        return new SecurityRiskPolicySnapshotV2(
            "risk:test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
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

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicySnapshotV2 policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicySnapshot CurrentRiskPolicy => SecurityRiskPolicySnapshotV2Adapter.ToLegacy(policy);

        public SecurityRiskPolicySnapshotV2 CurrentRiskPolicyV2 => policy;
    }

    private sealed class NullRiskSink : ISecurityRiskSignalSink
    {
        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
            => ValueTask.CompletedTask;
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
            SecurityRiskPolicySnapshotV2 currentPolicy,
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
