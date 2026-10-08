using System.Net;
using System.Security.Claims;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RequiresRiskControlFilterTests
{
    private const string ChallengeId = "018ff2fe-7a68-7cc0-9e6c-111111111111";

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_AllowDecision_EntersBusinessLogicWithoutConsumingProof()
    {
        FilterFixture fixture = CreateFixture(riskScore: 0);
        var context = CreateContext();
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.True(nextCalled);
        Assert.Equal("ok", result);
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        Assert.Empty(fixture.RiskSink.Signals);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-proof-required-before-business")]
    public async Task InvokeAsync_ChallengeWithoutProof_Returns428BeforeBusinessLogic()
    {
        FilterFixture fixture = CreateFixture(riskScore: 50);
        var context = CreateContext();
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, await ExecuteStatusAsync(result, context));
        AssertChallengeHandoff(context, RiskActionNames.PublicRead, "article:42", "challenge");
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal(0, signal.Score);
        Assert.Equal("challenge_proof_missing", signal.Detail);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_ChallengeWithAcceptedProof_ConsumesProofBeforeBusinessLogic()
    {
        FilterFixture fixture = CreateFixture(riskScore: 50);
        fixture.ProofService.NextConsumeResult = SecurityChallengeProofConsumeResult.Success(CreateClaims());
        var context = CreateContext();
        AddProofHeaders(context, "proof-ok");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.True(nextCalled);
        Assert.Equal("ok", result);
        SecurityChallengeProofConsumeRequest request = Assert.Single(fixture.ProofService.ConsumeRequests);
        Assert.Equal("proof-ok", request.ProofToken);
        Assert.Equal(ChallengeId, request.ChallengeId);
        Assert.Equal(Sha256PowChallengeProvider.WireKind, request.Kind);
        Assert.Equal(RiskActionNames.PublicRead, request.Action);
        Assert.Equal("article:42", request.RouteKey);
        Assert.Matches("^[0-9a-f]{64}$", request.SubjectHash);
        Assert.Matches("^[0-9a-f]{64}$", request.ClientIpHash);
        Assert.Matches("^[0-9a-f]{64}$", request.DeviceFpHash);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_MultiChallengeDecisionConsumesOneAggregateProofBeforeBusinessLogic()
    {
        SecurityRiskPolicy policy = CreateMultiChallengePolicy();
        FilterFixture fixture = CreateFixture(riskScore: 65, policy);
        fixture.ProofService.NextConsumeResult = SecurityChallengeProofConsumeResult.Success(CreateClaims());
        var context = CreateContext();
        AddProofHeaders(context, "single-proof", Sha256PowChallengeProvider.WireKind);
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.True(nextCalled);
        Assert.Equal("ok", result);
        SecurityChallengeProofConsumeRequest request = Assert.Single(fixture.ProofService.ConsumeRequests);
        Assert.Equal([PerceptionLocalizationV2Provider.WireKind, Sha256PowChallengeProvider.WireKind], request.RequiredKinds);
        Assert.Empty(fixture.RiskSink.Signals);
    }

    [Theory]
    [InlineData(RiskActionNames.CommentCreate, "comment.create")]
    [InlineData(RiskActionNames.AuthLogin, "auth.login")]
    [InlineData(RiskActionNames.RecoveryKeyVerify, "recovery-key.verify")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_MatchingProofEntersBusinessLogicForBusinessRiskActions(string actionName, string routeKey)
    {
        RealProofFilterFixture fixture = CreateRealProofFixture(riskScore: 50);
        var context = CreateContext(actionName, routeKey);
        SecurityChallengeProofMintResult proof = await MintProofForContextAsync(fixture.ProofService, context);
        AddProofHeaders(context, proof.ProofToken);
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("business-ok");
            });

        Assert.True(nextCalled);
        Assert.Equal("business-ok", result);
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, attempt.Outcome);
        Assert.Equal("ok", attempt.Reason);
        Assert.Empty(fixture.RiskSink.Signals);
    }

    [Theory]
    [InlineData(RiskActionNames.CommentCreate, "comment.create", RiskActionNames.AuthLogin, "auth.login", "device-123456", "action_mismatch")]
    [InlineData(RiskActionNames.CommentCreate, "comment.create", RiskActionNames.CommentCreate, "comment.reply", "device-123456", "route_key_mismatch")]
    [InlineData(RiskActionNames.AuthLogin, "auth.login", RiskActionNames.AuthLogin, "auth.login", "device-654321", "device_fp_hash_mismatch")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-proof-business-binding-required")]
    public async Task InvokeAsync_RejectsProofBoundToDifferentBusinessRequest(
        string mintedAction,
        string mintedRouteKey,
        string requestAction,
        string requestRouteKey,
        string requestDeviceFingerprint,
        string expectedReason)
    {
        RealProofFilterFixture fixture = CreateRealProofFixture(riskScore: 50);
        var mintContext = CreateContext(mintedAction, mintedRouteKey);
        SecurityChallengeProofMintResult proof = await MintProofForContextAsync(fixture.ProofService, mintContext);
        var requestContext = CreateContext(requestAction, requestRouteKey, requestDeviceFingerprint);
        AddProofHeaders(requestContext, proof.ProofToken);
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(requestContext),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("business-ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, await ExecuteStatusAsync(result, requestContext));
        AssertChallengeHandoff(requestContext, requestAction, requestRouteKey, "challenge");
        SecurityChallengeAttemptRequest attempt = Assert.Single(fixture.Persistence.Attempts);
        Assert.Equal(SecurityChallengeAttemptOutcomes.Failed, attempt.Outcome);
        Assert.Equal(expectedReason, attempt.Reason);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal($"challenge_proof_rejected:{expectedReason}", signal.Detail);
        Assert.Equal(requestAction, signal.Action);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "challenge-proof-single-use")]
    public async Task InvokeAsync_ReplayProofIsRejectedBeforeBusinessLogic()
    {
        RealProofFilterFixture fixture = CreateRealProofFixture(riskScore: 50);
        var firstContext = CreateContext(RiskActionNames.AuthLogin, "auth.login");
        SecurityChallengeProofMintResult proof = await MintProofForContextAsync(fixture.ProofService, firstContext);
        AddProofHeaders(firstContext, proof.ProofToken);

        object? firstResult = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(firstContext),
            _ => ValueTask.FromResult<object?>("first-ok"));

        Assert.Equal("first-ok", firstResult);

        var replayContext = CreateContext(RiskActionNames.AuthLogin, "auth.login");
        AddProofHeaders(replayContext, proof.ProofToken);
        bool replayNextCalled = false;

        object? replayResult = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(replayContext),
            _ =>
            {
                replayNextCalled = true;
                return ValueTask.FromResult<object?>("replay-ok");
            });

        Assert.False(replayNextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, await ExecuteStatusAsync(replayResult, replayContext));
        Assert.Collection(
            fixture.Persistence.Attempts,
            attempt => Assert.Equal(SecurityChallengeAttemptOutcomes.Verified, attempt.Outcome),
            attempt =>
            {
                Assert.Equal(SecurityChallengeAttemptOutcomes.Replayed, attempt.Outcome);
                Assert.Equal("proof_replayed_or_missing", attempt.Reason);
            });
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal("challenge_proof_rejected:proof_replayed_or_missing", signal.Detail);
        Assert.Equal(RiskActionNames.AuthLogin, signal.Action);
    }

    [Theory]
    [InlineData("proof_replayed_or_missing", SecurityChallengeProofOutcomes.ReplayedOrMissing)]
    [InlineData("proof_expired", SecurityChallengeProofOutcomes.Expired)]
    [InlineData("action_mismatch", SecurityChallengeProofOutcomes.BindingMismatch)]
    [InlineData("proof_revoked", SecurityChallengeProofOutcomes.Revoked)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "rejected-challenge-proof-cannot-enter-business")]
    public async Task InvokeAsync_RejectedProof_Returns428AndDoesNotEnterBusinessLogic(string reason, string outcome)
    {
        FilterFixture fixture = CreateFixture(riskScore: 50);
        fixture.ProofService.NextConsumeResult = SecurityChallengeProofConsumeResult.Rejected(reason);
        var context = CreateContext();
        AddProofHeaders(context, "proof-rejected");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, await ExecuteStatusAsync(result, context));
        Assert.Equal(outcome, context.Response.Headers[RequiresRiskControlFilter.ChallengeProofOutcomeHeaderName]);
        AssertChallengeHandoff(context, RiskActionNames.PublicRead, "article:42", "challenge");
        Assert.Single(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal($"challenge_proof_rejected:{reason}", signal.Detail);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "admin-sensitive-action-proof-authority")]
    public async Task InvokeAsync_AdminSensitiveActionRejectsOrdinaryChallengeProofWithoutBusinessLogic()
    {
        FilterFixture fixture = CreateFixture(riskScore: 50);
        fixture.ProofService.NextConsumeResult = SecurityChallengeProofConsumeResult.Success(CreateClaims(
            RiskActionNames.AdminSecurityWrite,
            "admin.security.write"));
        var context = CreateContext(RiskActionNames.AdminSecurityWrite, "admin.security.write");
        AddProofHeaders(context, "ordinary-v2-proof");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("admin-ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, await ExecuteStatusAsync(result, context));
        AssertChallengeHandoff(context, RiskActionNames.AdminSecurityWrite, "admin.security.write", "challenge");
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal("ordinary_challenge_proof_not_allowed_for_admin_sensitive", signal.Detail);
        Assert.Equal(RiskActionNames.AdminSecurityWrite, signal.Action);
    }

    [Theory]
    [InlineData(RiskActionNames.CommentCreate, "comment.create")]
    [InlineData(RiskActionNames.AuthLogin, "auth.login")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "write-challenge-human-read-proof-cannot-substitute")]
    public async Task InvokeAsync_WriteChallengeWithHumanReadProofKind_Returns428WithoutConsumingProof(string actionName, string routeKey)
    {
        FilterFixture fixture = CreateFixture(riskScore: 50);
        var context = CreateContext(actionName, routeKey);
        AddProofHeaders(context, "human-read-proof", "humanReadProofV1");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, await ExecuteStatusAsync(result, context));
        AssertChallengeHandoff(context, actionName, routeKey, "challenge");
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal($"challenge_kind_mismatch:humanReadProofV1", signal.Detail);
        Assert.Equal(actionName, signal.Action);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_BlockDecision_Returns429WithoutConsumingProofOrBusinessLogic()
    {
        FilterFixture fixture = CreateFixture(riskScore: 100);
        var context = CreateContext();
        AddProofHeaders(context, "proof-unused");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status429TooManyRequests, await ExecuteStatusAsync(result, context));
        Assert.Equal("block", context.Response.Headers[RequiresRiskControlFilter.RiskDecisionHeaderName]);
        Assert.Equal(SecurityRiskPolicyFactory.DefaultPolicyVersion, context.Response.Headers[RequiresRiskControlFilter.ChallengePolicyVersionHeaderName]);
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Contains("risk_control_blocked", signal.Detail, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_CommentQueueDecision_StoresDecisionContextAndEntersBusinessLogic()
    {
        SecurityRiskPolicy policy = CreateCommentQueuePolicy();
        FilterFixture fixture = CreateFixture(riskScore: 90, policy);
        var context = CreateContext(RiskActionNames.CommentCreate, "comment.create");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                Assert.True(context.Items.TryGetValue(RiskControlDecisionContext.HttpContextItemKey, out object? value));
                RiskControlDecisionContext decisionContext = Assert.IsType<RiskControlDecisionContext>(value);
                Assert.Equal(RiskDecisionKind.QueueForModeration, decisionContext.Decision.Kind);
                Assert.Equal(RiskActionNames.CommentCreate, decisionContext.Decision.ActionName);
                return ValueTask.FromResult<object?>("queued");
            });

        Assert.True(nextCalled);
        Assert.Equal("queued", result);
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal(RiskActionNames.CommentCreate, signal.Action);
        Assert.Contains("risk_control_queue", signal.Detail, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task InvokeAsync_CriticalAuthThrottle_RecordsRiskControlEventWithoutProofOrBusinessLogic()
    {
        SecurityRiskPolicy policy = CreateCriticalAuthThrottlePolicy();
        FilterFixture fixture = CreateFixture(riskScore: 80, policy);
        var context = CreateContext(RiskActionNames.AuthLogin, "auth.login");
        AddProofHeaders(context, "proof-unused");
        bool nextCalled = false;

        object? result = await fixture.Filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status429TooManyRequests, await ExecuteStatusAsync(result, context));
        Assert.Equal("throttle", context.Response.Headers[RequiresRiskControlFilter.RiskDecisionHeaderName]);
        Assert.Equal(SecurityRiskPolicyFactory.DefaultPolicyVersion, context.Response.Headers[RequiresRiskControlFilter.ChallengePolicyVersionHeaderName]);
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal(RiskActionNames.AuthLogin, signal.Action);
        Assert.Contains("risk_control_throttled", signal.Detail, StringComparison.Ordinal);
        Assert.Contains("perception_sealed_v2_auth_throttle", signal.Detail, StringComparison.Ordinal);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void RequiresPowFilter_RemainsLegacyPowWrapper()
    {
        Type[] constructorParameters = typeof(RequiresPowFilter)
            .GetConstructors()
            .Single()
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Contains(typeof(IPowService), constructorParameters);
        Assert.Contains(typeof(AdaptivePowGovernor), constructorParameters);
        Assert.DoesNotContain(typeof(ISecurityChallengeProofService), constructorParameters);
        Assert.DoesNotContain(typeof(IRiskDecisionService), constructorParameters);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void RequiresPowFilter_DoesNotKeepMvcAttributeOrRegistration()
    {
        const string LegacyTypeName = "FsusBlog.Server.Infrastructure.Filters.RequiresPowAttribute";
        Assert.Null(typeof(RequiresPowFilter).Assembly.GetType(LegacyTypeName, throwOnError: false));

        var services = new ServiceCollection();
        services.AddPowServices();

        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(IPowService)
            && descriptor.ImplementationType == typeof(RedisPowService)
            && descriptor.Lifetime == ServiceLifetime.Singleton);
        Assert.Contains(services, static descriptor =>
            descriptor.ServiceType == typeof(AdaptivePowGovernor)
            && descriptor.Lifetime == ServiceLifetime.Singleton);
        Assert.DoesNotContain(services, static descriptor =>
            typeof(IAsyncActionFilter).IsAssignableFrom(descriptor.ServiceType)
            || (descriptor.ImplementationType is not null
                && typeof(IAsyncActionFilter).IsAssignableFrom(descriptor.ImplementationType))
            || string.Equals(descriptor.ServiceType.FullName, LegacyTypeName, StringComparison.Ordinal));
    }

    private static FilterFixture CreateFixture(int riskScore, SecurityRiskPolicy? policy = null)
    {
        policy ??= CreatePolicy();
        var riskSink = new CapturingRiskSink();
        var proof = new CapturingProofService();
        var filter = new RequiresRiskControlFilter(
            new FixedRiskScoreReader(riskScore),
            riskSink,
            new FixedRiskPolicyProvider(policy),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            proof,
            NullLogger<RequiresRiskControlFilter>.Instance);

        return new FilterFixture(filter, proof, riskSink);
    }

    private static RealProofFilterFixture CreateRealProofFixture(int riskScore, SecurityRiskPolicy? policy = null)
    {
        policy ??= CreatePolicy();
        var riskSink = new CapturingRiskSink();
        var persistence = new RecordingChallengePersistence();
        var proofCache = new MemoryProofCache();
        var proof = new SecurityChallengeProofService(
            proofCache,
            proofCache,
            persistence,
            new FixedTimeProvider(DateTimeOffset.UtcNow));
        var filter = new RequiresRiskControlFilter(
            new FixedRiskScoreReader(riskScore),
            riskSink,
            new FixedRiskPolicyProvider(policy),
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            proof,
            NullLogger<RequiresRiskControlFilter>.Instance);

        return new RealProofFilterFixture(filter, proof, persistence, riskSink);
    }

    private static DefaultHttpContext CreateContext(
        string actionName = RiskActionNames.PublicRead,
        string routeKey = "article:42",
        string deviceFingerprint = "device-123456",
        ClaimsPrincipal? user = null)
    {
        var context = new DefaultHttpContext();
        context.RequestServices = new ServiceCollection()
            .AddLogging()
            .BuildServiceProvider();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        context.Request.Headers["X-Fsus-Device-Fp"] = deviceFingerprint;
        if (user is not null)
        {
            context.User = user;
        }
        context.SetEndpoint(CreateEndpoint(actionName, routeKey));
        return context;
    }

    private static async Task<SecurityChallengeProofMintResult> MintProofForContextAsync(
        SecurityChallengeProofService proofService,
        DefaultHttpContext context)
    {
        RiskControlContext riskContext = new RiskControlContextFactory().Create(context);
        RiskControlProofBinding binding = RiskControlProofBindingFactory.Create(riskContext);
        return await proofService.MintProofAsync(
            new SecurityChallengeProofMintRequest(
                ChallengeId,
                Sha256PowChallengeProvider.WireKind,
                riskContext.ActionName,
                riskContext.RouteKey,
                binding.SubjectHash,
                binding.ClientIpHash,
                binding.DeviceFpHash,
                SecurityRiskPolicyFactory.DefaultPolicyVersion,
                DateTimeOffset.UtcNow,
                DateTimeOffset.UtcNow.AddMinutes(5)),
            CancellationToken.None);
    }

    private static Endpoint CreateEndpoint(string actionName, string routeKey)
    {
        var builder = new RouteEndpointBuilder(_ => Task.CompletedTask, RoutePatternFactory.Parse($"/{routeKey}"), 0);
        builder.Metadata.Add(RiskActionRegistry.Default.CreateMetadata(actionName, routeKey));
        return builder.Build();
    }

    private static void AddProofHeaders(DefaultHttpContext context, string proof, string kind = Sha256PowChallengeProvider.WireKind)
    {
        context.Request.Headers[RequiresRiskControlFilter.ChallengeProofHeaderName] = proof;
        context.Request.Headers[RequiresRiskControlFilter.ChallengeIdHeaderName] = ChallengeId;
        context.Request.Headers[RequiresRiskControlFilter.ChallengeKindHeaderName] = kind;
    }

    private static async Task<int> ExecuteStatusAsync(object? result, DefaultHttpContext context)
    {
        Assert.IsAssignableFrom<IResult>(result);
        await ((IResult)result!).ExecuteAsync(context);
        return context.Response.StatusCode;
    }

    private static void AssertChallengeHandoff(
        DefaultHttpContext context,
        string action,
        string routeKey,
        string decision)
    {
        Assert.Equal(decision, context.Response.Headers[RequiresRiskControlFilter.RiskDecisionHeaderName]);
        Assert.Equal(action, context.Response.Headers[RequiresRiskControlFilter.ChallengeActionHeaderName]);
        Assert.Equal(routeKey, context.Response.Headers[RequiresRiskControlFilter.ChallengeRouteKeyHeaderName]);
        Assert.Equal(
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
            context.Response.Headers[RequiresRiskControlFilter.ChallengePolicyVersionHeaderName]);
    }

    private static SecurityChallengeProofClaims CreateClaims(
        string action = RiskActionNames.PublicRead,
        string routeKey = "article:42")
        => new(
            ChallengeId,
            Sha256PowChallengeProvider.WireKind,
            action,
            routeKey,
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.AddMinutes(5),
            "nonce",
            SecurityRiskPolicyFactory.DefaultPolicyVersion);

    private static SecurityRiskPolicy CreatePolicy()
    {
        var defaultPolicy = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
            Sha256PowChallengeProvider.WireKind,
            1,
            null,
            AnonymousWriteAllowed: false);
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.PublicRead] = defaultPolicy with
            {
                ActionName = RiskActionNames.PublicRead,
                AnonymousWriteAllowed = true
            }
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
            overrides,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce
            });
    }

    private static SecurityRiskPolicy CreateCommentQueuePolicy()
    {
        var commentPolicy = new SecurityRiskActionPolicy(
            RiskActionNames.CommentCreate,
            new SecurityRiskActionThresholds(49, 50, 70, 90, 100),
            Sha256PowChallengeProvider.WireKind,
            1,
            null,
            AnonymousWriteAllowed: true);

        return CreatePolicy() with
        {
            ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.CommentCreate] = commentPolicy
            }
        };
    }

    private static SecurityRiskPolicy CreateCriticalAuthThrottlePolicy()
    {
        var authPolicy = new SecurityRiskActionPolicy(
            RiskActionNames.AuthLogin,
            new SecurityRiskActionThresholds(19, 20, 60, 80, 90),
            Sha256PowChallengeProvider.WireKind,
            1,
            null,
            AnonymousWriteAllowed: false)
        {
            DecisionMatrix = SecurityRiskPolicyFactory.PerceptionSealedV2Matrix,
            DecisionBands =
            [
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Allow, 0, 19, [], 0, "perception_sealed_v2_allow"),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Throttle, 80, 89, [], 0, "perception_sealed_v2_auth_throttle")
            ]
        };

        return CreatePolicy() with
        {
            ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.AuthLogin] = authPolicy
            }
        };
    }

    private static SecurityRiskPolicy CreateMultiChallengePolicy()
    {
        var policy = new SecurityRiskActionPolicy(
            RiskActionNames.PublicRead,
            new SecurityRiskActionThresholds(19, 20, 60, 90, 100),
            Sha256PowChallengeProvider.WireKind,
            1,
            null,
            AnonymousWriteAllowed: true)
        {
            HardChallengeKinds = ["perceptionLocalizationV2", Sha256PowChallengeProvider.WireKind],
            HardChallengeEscalationLevel = 3
        };

        return CreatePolicy() with
        {
            ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.PublicRead] = policy
            },
            SubsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.Pow] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PerceptionLocalization] = SecuritySystemModes.Enforce
            }
        };
    }

    private sealed record FilterFixture(
        RequiresRiskControlFilter Filter,
        CapturingProofService ProofService,
        CapturingRiskSink RiskSink);

    private sealed record RealProofFilterFixture(
        RequiresRiskControlFilter Filter,
        SecurityChallengeProofService ProofService,
        RecordingChallengePersistence Persistence,
        CapturingRiskSink RiskSink);

    private sealed class TestEndpointFilterInvocationContext(HttpContext httpContext) : EndpointFilterInvocationContext
    {
        public override HttpContext HttpContext { get; } = httpContext;

        public override IList<object?> Arguments { get; } = [];

        public override T GetArgument<T>(int index) => (T)Arguments[index]!;
    }

    private sealed class FixedRiskScoreReader(int score) : ISecurityRiskScoreReader
    {
        public Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.FromResult(score);

        public Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(score);

        public Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicy policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicy CurrentRiskPolicy => policy;
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

    private sealed class CapturingProofService : ISecurityChallengeProofService
    {
        public SecurityChallengeProofConsumeResult NextConsumeResult { get; set; } = SecurityChallengeProofConsumeResult.Rejected("proof_replayed_or_missing");

        public List<SecurityChallengeProofConsumeRequest> ConsumeRequests { get; } = [];

        public Task<SecurityChallengeProofMintResult> MintProofAsync(SecurityChallengeProofMintRequest request, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<SecurityChallengeProofConsumeResult> ConsumeProofAsync(SecurityChallengeProofConsumeRequest request, CancellationToken cancellationToken = default)
        {
            ConsumeRequests.Add(request);
            return Task.FromResult(NextConsumeResult);
        }
    }

    private sealed class MemoryProofCache : IUnifiedCache
    {
        private readonly Dictionary<string, byte[]> _values = new(StringComparer.Ordinal);

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        {
            _values[BuildKey(policyId, identity)] = value;
            return Task.CompletedTask;
        }

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
            CancellationToken cancellationToken = default)
        {
            string key = BuildKey(policyId, identity);
            if (!_values.Remove(key, out byte[]? value))
            {
                return Task.FromResult(new CacheReadResult<T>(false, default));
            }

            var (success, decoded) = decoder(value);
            return Task.FromResult(success
                ? new CacheReadResult<T>(true, decoded)
                : new CacheReadResult<T>(false, default));
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}";

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class RecordingChallengePersistence : ISecurityChallengePersistenceService
    {
        public List<SecurityChallengeAttemptRequest> Attempts { get; } = [];

        public Task<SecurityChallenge> IssueAsync(SecurityChallengeIssueRequest request, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<SecurityChallengeAttempt> RecordAttemptAsync(SecurityChallengeAttemptRequest request, CancellationToken cancellationToken = default)
        {
            Attempts.Add(request);
            return Task.FromResult(new SecurityChallengeAttempt
            {
                ChallengeId = request.ChallengeId,
                Outcome = request.Outcome,
                Reason = request.Reason,
                PayloadHash = request.PayloadHash,
                ClientIpHash = request.ClientIpHash,
                DeviceFpHash = request.DeviceFpHash,
                TraceId = request.TraceId,
                Traceparent = request.Traceparent,
                AttemptedAtUtc = request.AttemptedAtUtc ?? DateTime.UtcNow
            });
        }

        public Task<bool> ExpireAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task<bool> RevokeAsync(string challengeId, string? reason = null, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
