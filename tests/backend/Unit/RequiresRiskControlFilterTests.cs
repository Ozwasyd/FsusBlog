using System.Net;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.Routing.Patterns;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RequiresRiskControlFilterTests
{
    private const string ChallengeId = "018ff2fe-7a68-7cc0-9e6c-111111111111";

    [Fact]
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
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal(SecurityRiskReason.SecurityChallengeRejected, signal.Reason);
        Assert.Equal(SecurityRiskSources.RiskControl, signal.Source);
        Assert.Equal("challenge_proof_missing", signal.Detail);
    }

    [Fact]
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

    [Theory]
    [InlineData("proof_replayed_or_missing")]
    [InlineData("action_mismatch")]
    public async Task InvokeAsync_RejectedProof_Returns428AndDoesNotEnterBusinessLogic(string reason)
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
        Assert.Single(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal($"challenge_proof_rejected:{reason}", signal.Detail);
    }

    [Theory]
    [InlineData(RiskActionNames.CommentCreate, "comment.create")]
    [InlineData(RiskActionNames.AuthLogin, "auth.login")]
    [InlineData(RiskActionNames.AdminSecurityWrite, "admin.security.write")]
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
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Equal($"challenge_kind_mismatch:humanReadProofV1", signal.Detail);
        Assert.Equal(actionName, signal.Action);
    }

    [Fact]
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
        Assert.Empty(fixture.ProofService.ConsumeRequests);
        SecurityRiskSignal signal = Assert.Single(fixture.RiskSink.Signals);
        Assert.Contains("risk_control_blocked", signal.Detail, StringComparison.Ordinal);
    }

    [Fact]
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

    private static FilterFixture CreateFixture(int riskScore)
    {
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy();
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

    private static DefaultHttpContext CreateContext(
        string actionName = RiskActionNames.PublicRead,
        string routeKey = "article:42")
    {
        var context = new DefaultHttpContext();
        context.RequestServices = new ServiceCollection()
            .AddLogging()
            .BuildServiceProvider();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        context.Request.Headers["X-Fsus-Device-Fp"] = "device-123456";
        context.SetEndpoint(CreateEndpoint(actionName, routeKey));
        return context;
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

    private static SecurityChallengeProofClaims CreateClaims()
        => new(
            ChallengeId,
            Sha256PowChallengeProvider.WireKind,
            RiskActionNames.PublicRead,
            "article:42",
            new string('a', 64),
            new string('b', 64),
            new string('c', 64),
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.AddMinutes(5),
            "nonce",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion);

    private static SecurityRiskPolicySnapshotV2 CreatePolicy()
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

        return new SecurityRiskPolicySnapshotV2(
            "risk:test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
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

    private sealed record FilterFixture(
        RequiresRiskControlFilter Filter,
        CapturingProofService ProofService,
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

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicySnapshotV2 policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicySnapshot CurrentRiskPolicy => SecurityRiskPolicySnapshotV2Adapter.ToLegacy(policy);

        public SecurityRiskPolicySnapshotV2 CurrentRiskPolicyV2 => policy;
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
}
