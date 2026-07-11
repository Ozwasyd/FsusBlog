using FsusBlog.Server.Infrastructure.Cache;
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
        Assert.True(PublicHotReadFastPath.RequiresSecurityGateForRequestForTests("/article/42"));
        Assert.False(PublicHotReadFastPath.RequiresSecurityGateForRequestForTests("/api/binary/article/42/related.aeds"));

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

            await middleware.InvokeAsync(
                context,
                CreateRiskScoreReader(),
                sink,
                CreatePolicyProvider(),
                new RiskControlContextFactory(),
                CreateDecisionService(kind),
                NullLogger<PublicHotReadSecurityGateMiddleware>.Instance,
                Substitute.For<IPowService>(),
                new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()));

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
        await challengeMiddleware.InvokeAsync(
            challengeContext,
            CreateRiskScoreReader(),
            challengeSink,
            CreatePolicyProvider(),
            new RiskControlContextFactory(),
            CreateDecisionService(RiskDecisionKind.Challenge),
            NullLogger<PublicHotReadSecurityGateMiddleware>.Instance,
            Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<IUnifiedCache>()));
        Assert.False(challengeNextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, challengeContext.Response.StatusCode);
        SecurityRiskSignal challengeSignal = Assert.Single(challengeSink.Signals);
        Assert.Equal(SecurityRiskSources.PublicRead, challengeSignal.Source);
        Assert.Equal(SecurityRiskReason.PublicReadChallengeRequired, challengeSignal.Reason);
        Assert.Equal(0, challengeSignal.Score);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().BuildServiceProvider()
        };
        context.Request.Path = "/article/42";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static ISecurityRiskScoreReader CreateRiskScoreReader()
    {
        var reader = Substitute.For<ISecurityRiskScoreReader>();
        reader.GetRiskScoreAsync(Arg.Any<HttpContext>(), Arg.Any<CancellationToken>()).Returns(50);
        return reader;
    }

    private static ISecurityRiskPolicyProvider CreatePolicyProvider()
    {
        var provider = Substitute.For<ISecurityRiskPolicyProvider>();
        provider.CurrentRiskPolicyV2.Returns(CreatePolicy());
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
}
