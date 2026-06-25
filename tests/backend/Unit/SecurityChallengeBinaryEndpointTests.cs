using System.Net;
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
using FsusBlog.Server.Tests.TestInfrastructure;
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
            VerifyResult = SecurityChallengeOrchestrationVerifyResult.Success("fcp_token")
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
            VerifyResult = SecurityChallengeOrchestrationVerifyResult.Success("fcp_token")
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
    public void SecurityChallengePayloadDeserializers_SourceUseBoundedWebJsonOptions()
    {
        string endpointSource = BackendTestPaths.ReadAllTextFromRoot("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.SecurityChallenge.cs");
        string adminPrincipalSource = BackendTestPaths.ReadAllTextFromRoot("src/backend/Services/Security/AdminPrincipalService.cs");

        Assert.Contains("new(JsonSerializerDefaults.Web)", endpointSource, StringComparison.Ordinal);
        Assert.Contains("MaxDepth = 32", endpointSource, StringComparison.Ordinal);
        Assert.Contains("MaxSecurityChallengeProviderPayloadEntries", endpointSource, StringComparison.Ordinal);
        Assert.Contains("MaxSecurityChallengeProviderPayloadValueChars", endpointSource, StringComparison.Ordinal);
        Assert.Contains("parsed.Count > MaxSecurityChallengeProviderPayloadEntries", endpointSource, StringComparison.Ordinal);
        Assert.Contains("item.Value.Length > MaxSecurityChallengeProviderPayloadValueChars", endpointSource, StringComparison.Ordinal);
        Assert.Contains("JsonSerializer.Deserialize<Dictionary<string, string>>(payloadJson, SecurityChallengeProviderPayloadJsonOptions)", endpointSource, StringComparison.Ordinal);

        Assert.Contains("new(JsonSerializerDefaults.Web)", adminPrincipalSource, StringComparison.Ordinal);
        Assert.Contains("MaxDepth = 32", adminPrincipalSource, StringComparison.Ordinal);
        Assert.Contains("JsonSerializer.Deserialize<T>(value, ChallengeCacheJsonOptions)", adminPrincipalSource, StringComparison.Ordinal);
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
        public SecurityChallengeOrchestrationIssueRequest? LastIssueRequest { get; private set; }

        public SecurityChallengeOrchestrationVerifyRequest? LastVerifyRequest { get; private set; }

        public int VerifyCallCount { get; private set; }

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
