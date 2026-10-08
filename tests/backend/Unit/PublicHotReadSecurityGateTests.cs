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
using Microsoft.Extensions.Options;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadSecurityGateTests
{
    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
                CreateProjection(),
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
            CreateProjection(),
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task SecurityGate_AllowWritesNoRiskEventAndEndpointFallbackReusesTheDecision()
    {
        var sink = new CapturingRiskSink();
        IPublicHotReadRiskProjection projection = CreateProjection();
        PublicReadSecurityGate gate = CreateGate(projection, sink, CreateDecisionService(RiskDecisionKind.Allow));
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
        Assert.Equal(
            PublicHotReadRiskProjectionSources.LocalPositive,
            context.Items[PublicHotReadRiskProjectionItemKeys.Source]);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task SecurityGate_DisabledPublicReadSkipsRiskScoreLookupAndStillUsesDecisionService()
    {
        var sink = new CapturingRiskSink();
        IPublicHotReadRiskProjection projection = Substitute.For<IPublicHotReadRiskProjection>();
        IRiskDecisionService decision = CreateDecisionService(RiskDecisionKind.Allow);
        SecurityRiskPolicy policy = CreatePolicy();
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
        PublicReadSecurityGate gate = CreateGate(projection, sink, decision, policy: policy);
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
        _ = projection.DidNotReceiveWithAnyArgs().Lookup((HttpContext)default!);
        Assert.Equal(
            PublicHotReadRiskProjectionSources.PolicyDisabled,
            context.Items[PublicHotReadRiskProjectionItemKeys.Source]);
        _ = decision.Received(1).Decide(
            Arg.Any<RiskControlContext>(),
            policy,
            0);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task DynamicRiskAwareFilter_KeepsStrongRiskScoreReaderAndNeverUsesL0Projection()
    {
        var sink = new CapturingRiskSink();
        IPublicHotReadRiskProjection projection = Substitute.For<IPublicHotReadRiskProjection>();
        ISecurityRiskScoreReader scoreReader = Substitute.For<ISecurityRiskScoreReader>();
        scoreReader.GetRiskScoreAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(50);
        IRiskDecisionService decision = CreateDecisionService(RiskDecisionKind.Allow);
        PublicReadSecurityGate gate = CreateGate(projection, sink, decision, riskScoreReader: scoreReader);
        DefaultHttpContext context = CreateContext();
        context.Request.Path = "/api/binary/comment/42/thread/7";
        var filter = new RiskAwarePublicReadFilter(gate);
        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ => ValueTask.FromResult<object?>("dynamic-ok"));

        Assert.Equal("dynamic-ok", result);
        Assert.Null(context.Features.Get<PublicHotReadRequestFeature>());
        _ = projection.DidNotReceiveWithAnyArgs().Lookup((HttpContext)default!);
        await scoreReader.Received(1).GetRiskScoreAsync(context, context.RequestAborted);
    }

    [Theory]
    [InlineData("VerifiedCrawler")]
    [InlineData("SocialPreviewBot")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task SecurityGate_VerifiedCrawlerAndSocialPreviewCanUseZeroRiskAllowPath(string identityFlag)
    {
        var sink = new CapturingRiskSink();
        IPublicHotReadRiskProjection projection = Substitute.For<IPublicHotReadRiskProjection>();
        IRiskDecisionService decision = CreateDecisionService(RiskDecisionKind.Allow);
        PublicReadSecurityGate gate = CreateGate(projection, sink, decision);
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
        _ = projection.DidNotReceiveWithAnyArgs().Lookup((HttpContext)default!);
        Assert.Equal(
            identityFlag == "VerifiedCrawler"
                ? PublicHotReadRiskProjectionSources.VerifiedCrawler
                : PublicHotReadRiskProjectionSources.SocialPreview,
            context.Items[PublicHotReadRiskProjectionItemKeys.Source]);
        _ = decision.Received(1).Decide(
            Arg.Any<RiskControlContext>(),
            Arg.Any<SecurityRiskPolicy>(),
            0);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "public-read-invalid-pow-proof-refused")]
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
            CreateGate(CreateProjection(), sink, CreateDecisionService(RiskDecisionKind.Challenge)));

        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        SecurityRiskSignal signal = Assert.Single(sink.Signals);
        Assert.Equal(SecurityRiskReason.PowInvalid, signal.Reason);
        Assert.Equal(SecurityRiskSources.Pow, signal.Source);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "public-read-unverified-pow-proof-refused")]
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
                CreateProjection(),
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
        IPublicHotReadRiskProjection riskProjection,
        ISecurityRiskSignalSink riskSignalSink,
        IRiskDecisionService riskDecisionService,
        IPowService? powService = null,
        SecurityRiskPolicy? policy = null,
        ISecurityRiskScoreReader? riskScoreReader = null)
        => new(
            riskProjection,
            riskScoreReader ?? CreateRiskScoreReader(),
            riskSignalSink,
            CreatePolicyProvider(policy),
            new RiskControlContextFactory(),
            riskDecisionService,
            NullLogger<PublicReadSecurityGate>.Instance,
            powService ?? Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()));

    private static ISecurityRiskScoreReader CreateRiskScoreReader()
    {
        var reader = Substitute.For<ISecurityRiskScoreReader>();
        reader.GetRiskScoreAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(50);
        return reader;
    }

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
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("198.51.100.1");
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static IPublicHotReadRiskProjection CreateProjection()
    {
        var projection = new PublicHotReadRiskProjection(
            Options.Create(new PublicHotReadRiskProjectionOptions()),
            new SecurityRiskPseudonymizer(1, new byte[32]),
            TimeProvider.System);
        Assert.True(projection.ApplyIdentity(
            "198.51.100.1",
            50,
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow.AddMinutes(10),
            Guid.NewGuid().ToString("N")));
        return projection;
    }

    private static ISecurityRiskPolicyProvider CreatePolicyProvider(SecurityRiskPolicy? policy = null)
    {
        var provider = Substitute.For<ISecurityRiskPolicyProvider>();
        provider.CurrentRiskPolicy.Returns(policy ?? CreatePolicy());
        return provider;
    }

    private static IRiskDecisionService CreateDecisionService(RiskDecisionKind kind)
    {
        var service = Substitute.For<IRiskDecisionService>();
        service.Decide(Arg.Any<RiskControlContext>(), Arg.Any<SecurityRiskPolicy>(), Arg.Any<int>())
            .Returns(new RiskDecision(
                kind,
                RiskActionNames.PublicRead,
                "public.hot-read.html",
                50,
                50,
                1,
                ["security.pow"],
                SecurityRiskPolicyFactory.DefaultPolicyVersion,
                ["unit"]));
        return service;
    }

    private static SecurityRiskPolicy CreatePolicy()
    {
        var action = new SecurityRiskActionPolicy(
            RiskActionNames.PublicRead,
            new SecurityRiskActionThresholds(10, 20, 30, 40, 50),
            "security.pow",
            1,
            null,
            AnonymousWriteAllowed: true);
        return new SecurityRiskPolicy(
            "runtime",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
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
