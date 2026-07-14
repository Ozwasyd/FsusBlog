using System.Buffers.Binary;
using System.Text;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadSecurityGateTests
{
    [Fact]
    public async Task SecurityGate_EnforcesPublicReadDecisionsAndTelemetryAtRuntime()
    {
        foreach (RiskDecisionKind kind in new[]
        {
            RiskDecisionKind.Block,
            RiskDecisionKind.Throttle,
            RiskDecisionKind.QueueForModeration
        })
        {
            var sink = new CapturingRiskSink();
            bool nextCalled = false;
            var middleware = new PublicHotReadSecurityGateMiddleware(_ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            });
            DefaultHttpContext context = CreateContext();
            AttachCandidateFeature(context);

            await middleware.InvokeAsync(context, CreateGate(
                CreateRiskScoreReader(),
                sink,
                CreateDecisionService(kind)));

            Assert.False(nextCalled);
            Assert.Equal(StatusCodes.Status429TooManyRequests, context.Response.StatusCode);
            SecurityRiskSignal signal = Assert.Single(sink.Signals);
            Assert.Equal(SecurityRiskSources.PublicRead, signal.Source);
            Assert.Equal(SecurityRiskReason.PublicReadBlocked, signal.Reason);
        }

        var challengeSink = new CapturingRiskSink();
        bool challengeNextCalled = false;
        var challengeMiddleware = new PublicHotReadSecurityGateMiddleware(_ =>
        {
            challengeNextCalled = true;
            return Task.CompletedTask;
        });
        DefaultHttpContext challengeContext = CreateContext();
        AttachCandidateFeature(challengeContext);
        await challengeMiddleware.InvokeAsync(challengeContext, CreateGate(
            CreateRiskScoreReader(),
            challengeSink,
            CreateDecisionService(RiskDecisionKind.Challenge)));
        Assert.False(challengeNextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, challengeContext.Response.StatusCode);
        SecurityRiskSignal challengeSignal = Assert.Single(challengeSink.Signals);
        Assert.Equal(SecurityRiskSources.PublicRead, challengeSignal.Source);
        Assert.Equal(SecurityRiskReason.PublicReadChallengeRequired, challengeSignal.Reason);
        Assert.Equal(0, challengeSignal.Score);
    }

    [Fact]
    public async Task SecurityGate_AllowWritesNoRiskEventAndEndpointFallbackReusesTheDecision()
    {
        var sink = new CapturingRiskSink();
        ISecurityRiskScoreReader reader = CreateRiskScoreReader();
        PublicReadSecurityGate gate = CreateGate(reader, sink, CreateDecisionService(RiskDecisionKind.Allow));
        var filter = new RiskAwarePublicReadFilter(gate);
        DefaultHttpContext context = CreateContext();
        AttachCandidateFeature(context);
        bool endpointCalled = false;
        var middleware = new PublicHotReadSecurityGateMiddleware(async httpContext =>
        {
            object? result = await filter.InvokeAsync(
                new TestEndpointFilterInvocationContext(httpContext),
                _ =>
                {
                    endpointCalled = true;
                    return ValueTask.FromResult<object?>("ok");
                });
            Assert.Equal("ok", result);
        });

        await middleware.InvokeAsync(context, gate);

        Assert.True(endpointCalled);
        Assert.Empty(sink.Signals);
        Assert.NotNull(context.Features.Get<PublicReadSecurityGateResultFeature>());
        await reader.Received(1).GetRiskScoreAsync(context, context.RequestAborted);
    }

    [Fact]
    public async Task SecurityGate_DisabledPublicReadSkipsRiskScoreLookupAndStillUsesDecisionService()
    {
        var sink = new CapturingRiskSink();
        ISecurityRiskScoreReader reader = Substitute.For<ISecurityRiskScoreReader>();
        IRiskDecisionService decision = CreateDecisionService(RiskDecisionKind.Allow);
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy();
        policy = policy with
        {
            ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.PublicRead] = policy.DefaultAction with
                {
                    ActionName = RiskActionNames.PublicRead,
                    ModeOverride = SecuritySystemModes.Disabled
                }
            }
        };
        PublicReadSecurityGate gate = CreateGate(reader, sink, decision, policy: policy);
        DefaultHttpContext context = CreateContext();
        AttachCandidateFeature(context);
        bool nextCalled = false;
        var middleware = new PublicHotReadSecurityGateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        await middleware.InvokeAsync(context, gate);

        Assert.True(nextCalled);
        Assert.Empty(sink.Signals);
        await reader.DidNotReceiveWithAnyArgs().GetRiskScoreAsync((HttpContext)default!, default);
        _ = decision.Received(1).Decide(
            Arg.Any<RiskControlContext>(),
            policy,
            0);
    }

    [Theory]
    [InlineData("VerifiedCrawler")]
    [InlineData("SocialPreviewBot")]
    public async Task SecurityGate_VerifiedCrawlerAndSocialPreviewCanUseZeroRiskAllowPath(string identityFlag)
    {
        var sink = new CapturingRiskSink();
        ISecurityRiskScoreReader reader = Substitute.For<ISecurityRiskScoreReader>();
        IRiskDecisionService decision = CreateDecisionService(RiskDecisionKind.Allow);
        PublicReadSecurityGate gate = CreateGate(reader, sink, decision);
        DefaultHttpContext context = CreateContext();
        context.Items[identityFlag] = true;
        AttachCandidateFeature(context);
        bool nextCalled = false;
        var middleware = new PublicHotReadSecurityGateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        await middleware.InvokeAsync(context, gate);

        Assert.True(nextCalled);
        Assert.Empty(sink.Signals);
        await reader.DidNotReceiveWithAnyArgs().GetRiskScoreAsync((HttpContext)default!, default);
        _ = decision.Received(1).Decide(
            Arg.Any<RiskControlContext>(),
            Arg.Any<SecurityRiskPolicySnapshotV2>(),
            0);
    }

    [Fact]
    public async Task SecurityGate_InvalidProofIsRejectedAsPowFailureNotChallengeRequired()
    {
        var sink = new CapturingRiskSink();
        DefaultHttpContext context = CreateContext(sink);
        context.Request.Headers["X-Fsus-Pow-Proof"] = "not-base64";
        AttachCandidateFeature(context);
        var middleware = new PublicHotReadSecurityGateMiddleware(_ =>
            throw new InvalidOperationException("invalid proof must not reach writer"));

        await middleware.InvokeAsync(
            context,
            CreateGate(CreateRiskScoreReader(), sink, CreateDecisionService(RiskDecisionKind.Challenge)));

        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        SecurityRiskSignal signal = Assert.Single(sink.Signals);
        Assert.Equal(SecurityRiskReason.PowInvalid, signal.Reason);
        Assert.Equal(SecurityRiskSources.Pow, signal.Source);
    }

    [Fact]
    public async Task SecurityGate_ReplayedProofIsRejectedWithPowRiskSemantics()
    {
        var sink = new CapturingRiskSink();
        IPowService powService = Substitute.For<IPowService>();
        powService.VerifyAsync(Arg.Any<IPowRequest>(), Arg.Any<string>(), Arg.Any<string?>())
            .Returns(false);
        DefaultHttpContext context = CreateContext(sink);
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("203.0.113.42");
        context.Request.Headers["X-Fsus-Pow-Proof"] = CreateStructurallyValidPowProof();
        AttachCandidateFeature(context);
        var middleware = new PublicHotReadSecurityGateMiddleware(_ =>
            throw new InvalidOperationException("replayed proof must not reach writer"));

        await middleware.InvokeAsync(
            context,
            CreateGate(
                CreateRiskScoreReader(),
                sink,
                CreateDecisionService(RiskDecisionKind.Challenge),
                powService));

        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
        SecurityRiskSignal signal = Assert.Single(sink.Signals);
        Assert.Equal(SecurityRiskReason.PowInvalid, signal.Reason);
        Assert.Equal(SecurityRiskSources.Pow, signal.Source);
        await powService.Received(1).VerifyAsync(
            Arg.Any<IPowRequest>(),
            "203.0.113.42",
            Arg.Any<string?>());
    }

    private static void AttachCandidateFeature(DefaultHttpContext context)
    {
        Assert.True(PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out PublicHotReadRequestFeature? feature));
        context.Features.Set(Assert.IsType<PublicHotReadRequestFeature>(feature));
    }

    private static PublicReadSecurityGate CreateGate(
        ISecurityRiskScoreReader riskScoreReader,
        ISecurityRiskSignalSink riskSignalSink,
        IRiskDecisionService riskDecisionService,
        IPowService? powService = null,
        SecurityRiskPolicySnapshotV2? policy = null)
        => new(
            riskScoreReader,
            riskSignalSink,
            CreatePolicyProvider(policy),
            new RiskControlContextFactory(),
            riskDecisionService,
            NullLogger<PublicReadSecurityGate>.Instance,
            powService ?? Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()));

    private static string CreateStructurallyValidPowProof()
    {
        string[] fields = ["salt", "nonce", "signature", "browser-fingerprint"];
        int length = 17 + fields.Sum(static value => sizeof(ushort) + Encoding.UTF8.GetByteCount(value));
        byte[] bytes = new byte[length];
        "FPOW"u8.CopyTo(bytes);
        bytes[4] = 1;
        BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(5, sizeof(int)), 28);
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(9, sizeof(long)), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        int offset = 17;
        foreach (string value in fields)
        {
            int byteCount = Encoding.UTF8.GetByteCount(value);
            BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset, sizeof(ushort)), checked((ushort)byteCount));
            offset += sizeof(ushort);
            Encoding.UTF8.GetBytes(value, bytes.AsSpan(offset, byteCount));
            offset += byteCount;
        }

        return Convert.ToBase64String(bytes);
    }

    private static DefaultHttpContext CreateContext(ISecurityRiskSignalSink? sink = null)
    {
        var services = new ServiceCollection().AddLogging();
        if (sink is not null)
        {
            services.AddSingleton(sink);
        }

        var context = new DefaultHttpContext
        {
            RequestServices = services.BuildServiceProvider()
        };
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static ISecurityRiskScoreReader CreateRiskScoreReader()
    {
        var reader = Substitute.For<ISecurityRiskScoreReader>();
        reader.GetRiskScoreAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(50);
        return reader;
    }

    private static ISecurityRiskPolicyProvider CreatePolicyProvider(SecurityRiskPolicySnapshotV2? policy = null)
    {
        var provider = Substitute.For<ISecurityRiskPolicyProvider>();
        provider.CurrentRiskPolicyV2.Returns(policy ?? CreatePolicy());
        return provider;
    }

    private static IRiskDecisionService CreateDecisionService(RiskDecisionKind kind)
    {
        var service = Substitute.For<IRiskDecisionService>();
        service.Decide(Arg.Any<RiskControlContext>(), Arg.Any<SecurityRiskPolicySnapshotV2>(), Arg.Any<int>())
            .Returns(new RiskDecision(
                kind,
                RiskActionNames.PublicRead,
                "public.hot-read.html",
                50,
                50,
                1,
                ["security.pow"],
                SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
                ["unit"]));
        return service;
    }

    private static SecurityRiskPolicySnapshotV2 CreatePolicy()
    {
        var action = new SecurityRiskActionPolicy(
            RiskActionNames.PublicRead,
            new SecurityRiskActionThresholds(10, 20, 30, 40, 50),
            "security.pow",
            1,
            null,
            AnonymousWriteAllowed: true);
        return new SecurityRiskPolicySnapshotV2(
            "runtime",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
            DateTimeOffset.UtcNow,
            SecuritySystemModes.Enforce,
            200,
            125,
            null,
            action,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal));
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

    private sealed class TestEndpointFilterInvocationContext(HttpContext httpContext) : EndpointFilterInvocationContext
    {
        public override HttpContext HttpContext { get; } = httpContext;
        public override IList<object?> Arguments { get; } = [];
        public override T GetArgument<T>(int index) => (T)Arguments[index]!;
    }
}
