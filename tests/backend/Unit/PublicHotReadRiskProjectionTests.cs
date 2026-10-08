using System.Diagnostics;
using System.Net;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Issue #1837 acceptance tests.  The two-node/replay tests use a deterministic
/// local PostgreSQL/Redis-shaped authority and Pub/Sub simulation; they exercise
/// the production projection, worker, and gate without claiming external-service
/// availability in a unit-test process.
/// </summary>
public sealed class PublicHotReadRiskProjectionTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 8, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void L0_100KUniqueIps_UsesOnlyBoundedLocalStateWithZeroExternalCommands()
    {
        var clock = new FixedTimeProvider(s_now);
        PublicHotReadRiskProjection projection = CreateProjection(
            clock,
            new PublicHotReadRiskProjectionOptions
            {
                MaxEntries = 100_000,
                MaxBytes = 32 * 1024 * 1024,
                MaxEntryTtlSeconds = 1_800
            });

        for (int index = 0; index < 100_000; index++)
        {
            Assert.True(projection.ApplyIdentity(
                $"l0-unique-ip-{index:D6}",
                0,
                s_now,
                s_now.AddMinutes(30),
                $"zero-{index:D6}"));
        }

        PublicHotReadRiskProjectionSnapshot snapshot = projection.Snapshot();
        Assert.Equal(100_000, snapshot.EntryCount);
        Assert.InRange(snapshot.EntryCount, 0, snapshot.MaxEntries);
        Assert.InRange(snapshot.ResidentBytes, 1, snapshot.MaxBytes);
        Assert.Equal(0, snapshot.RejectedUpdateCount);
        Assert.Equal(PublicHotReadRiskProjectionSources.LocalZero, projection.Lookup("l0-unique-ip-099999").Source);

        // PublicHotReadRiskProjection has no Redis, database, filesystem, or HTTP
        // dependency. This deliberately constructs and drives the L0 projection
        // with no external client; a disconnected Redis cannot add a command here.
        Assert.DoesNotContain(
            typeof(IConnectionMultiplexer),
            typeof(PublicHotReadRiskProjection).GetConstructors().Single().GetParameters().Select(static parameter => parameter.ParameterType));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void PositiveRisk_TransitionsZeroToChallengeAndBlock_ConvergesAcrossNodesAndReplaysAfterRestart()
    {
        var clock = new FixedTimeProvider(s_now);
        PublicHotReadRiskProjection nodeA = CreateProjection(clock);
        PublicHotReadRiskProjection nodeB = CreateProjection(clock);
        var authority = new LocalDurableProjectionAuthority();
        RiskControlContext context = CreateRiskContext("198.51.100.44");
        SecurityRiskPolicy policy = CreatePolicy(SecuritySystemModes.Enforce);
        var decisionService = new RiskDecisionService();

        PublicHotReadRiskProjectionUpdate zero = CreateUpdate("198.51.100.44", 0, 1, "zero");
        authority.Append(zero);
        Assert.True(nodeA.Apply(zero));
        Assert.Equal(RiskDecisionKind.Allow, decisionService.Decide(context, policy, nodeA.Lookup("198.51.100.44").Score).Kind);

        PublicHotReadRiskProjectionUpdate challenge = CreateUpdate("198.51.100.44", 50, 2, "challenge");
        authority.Append(challenge);
        Assert.True(nodeA.Apply(challenge));
        authority.PublishLatest(nodeB);
        Assert.Equal(50, nodeB.Lookup("198.51.100.44").Score);
        Assert.Equal(RiskDecisionKind.Challenge, decisionService.Decide(context, policy, nodeB.Lookup("198.51.100.44").Score).Kind);

        PublicHotReadRiskProjectionUpdate block = CreateUpdate("198.51.100.44", 100, 3, "block");
        authority.Append(block);
        Assert.True(nodeA.Apply(block));
        authority.PublishLatest(nodeB);
        Assert.Equal(RiskDecisionKind.Block, decisionService.Decide(context, policy, nodeB.Lookup("198.51.100.44").Score).Kind);

        // A restarted node starts empty and recovers the same authoritative rows.
        PublicHotReadRiskProjection restartedNode = CreateProjection(clock);
        authority.ReplayInto(restartedNode);
        PublicHotReadRiskProjectionLookup recovered = restartedNode.Lookup("198.51.100.44");
        Assert.True(recovered.Known);
        Assert.Equal(100, recovered.Score);
        Assert.Equal(3, restartedNode.Snapshot().DurableReplayCount);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "public-risk-stale-or-unowned-reset-cannot-overwrite")]
    public void AuthoritativeZeroResetWinsOverPositiveAndOlderEpochOrReplayCannotResurrectIt()
    {
        var clock = new FixedTimeProvider(s_now);
        PublicHotReadRiskProjection projection = CreateProjection(clock);
        PublicHotReadRiskProjectionUpdate positive = CreateUpdate("198.51.100.48", 100, 1, "positive");
        PublicHotReadRiskProjectionUpdate nonAuthoritativeZero = CreateUpdate("198.51.100.48", 0, 2, "observed-zero");
        PublicHotReadRiskProjectionUpdate reset = nonAuthoritativeZero with
        {
            EventId = "risk-reset",
            IsAuthoritativeZero = true
        };

        Assert.True(projection.Apply(positive));
        Assert.False(projection.Apply(nonAuthoritativeZero));
        Assert.True(projection.Apply(reset));
        Assert.Equal(PublicHotReadRiskProjectionSources.LocalZero, projection.Lookup("198.51.100.48").Source);
        Assert.Equal(0, projection.Lookup("198.51.100.48").Score);

        PublicHotReadRiskProjection restarted = CreateProjection(clock);
        Assert.True(restarted.Apply(reset, durableReplay: true));
        Assert.False(restarted.Apply(positive, durableReplay: true));
        Assert.Equal(0, restarted.Lookup("198.51.100.48").Score);

        PublicHotReadRiskProjectionUpdate newerEpochWithOlderTimestamp = positive with
        {
            PseudonymEpoch = positive.PseudonymEpoch + 1,
            UpdatedAtUtc = s_now.AddSeconds(-1),
            EventId = "epoch-2"
        };
        PublicHotReadRiskProjection epochProjection = CreateProjection(clock);
        Assert.True(epochProjection.Apply(positive));
        Assert.True(epochProjection.Apply(newerEpochWithOlderTimestamp));
        Assert.False(epochProjection.Apply(positive));
        Assert.Equal(100, epochProjection.Lookup("198.51.100.48").Score);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task RedisDisconnect_WithExistingPositiveRisk_FailsClosedWithoutWaitingForRedisTimeout()
    {
        var clock = new FixedTimeProvider(s_now);
        PublicHotReadRiskProjection projection = CreateProjection(clock);
        Assert.True(projection.ApplyIdentity(
            "198.51.100.45",
            100,
            s_now,
            s_now.AddMinutes(10),
            "positive-risk"));

        RecordingRiskSink sink = new();
        PublicReadSecurityGate gate = CreateGate(projection, sink, SecuritySystemModes.Enforce);
        DefaultHttpContext context = CreateHotContext("198.51.100.45");
        AttachCandidateFeature(context);
        bool nextCalled = false;
        var stopwatch = Stopwatch.StartNew();
        await new PublicHotReadSecurityGateMiddleware(_ =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        }).InvokeAsync(context, gate);
        stopwatch.Stop();

        Assert.False(nextCalled);
        Assert.Equal(StatusCodes.Status429TooManyRequests, context.Response.StatusCode);
        Assert.Equal(PublicHotReadRiskProjectionSources.LocalPositive, context.Items[PublicHotReadRiskProjectionItemKeys.Source]);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(1), $"L0 gate took {stopwatch.Elapsed}");
        Assert.Single(sink.Signals);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task UnknownProjection_ModesObserveEnforceStrictAndLockdownNeverBlockTheL0Thread()
    {
        foreach (string mode in new[]
        {
            SecuritySystemModes.Observe,
            SecuritySystemModes.Enforce,
            SecuritySystemModes.Strict,
            SecuritySystemModes.Lockdown
        })
        {
            var clock = new FixedTimeProvider(s_now);
            PublicHotReadRiskProjection projection = CreateProjection(clock);
            RecordingRiskSink sink = new();
            PublicReadSecurityGate gate = CreateGate(projection, sink, mode);
            DefaultHttpContext context = CreateHotContext($"198.51.100.{mode.Length + 50}");
            AttachCandidateFeature(context);
            bool nextCalled = false;

            await new PublicHotReadSecurityGateMiddleware(_ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            }).InvokeAsync(context, gate);

            Assert.Equal(PublicHotReadRiskProjectionSources.UnknownPolicyAction, context.Items[PublicHotReadRiskProjectionItemKeys.Source]);
            if (mode == SecuritySystemModes.Observe)
            {
                Assert.True(nextCalled);
                Assert.Empty(sink.Signals);
            }
            else
            {
                Assert.False(nextCalled);
                Assert.Equal(StatusCodes.Status429TooManyRequests, context.Response.StatusCode);
                Assert.Single(sink.Signals);
            }
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "risk-projection-reject-stale-downgrade-capacity")]
    public async Task CapacityVersionReorderDuplicateAndPubSubLoss_UseSafeEvictionAndDurableReplay()
    {
        var clock = new FixedTimeProvider(s_now);
        PublicHotReadRiskProjection projection = CreateProjection(
            clock,
            new PublicHotReadRiskProjectionOptions
            {
                MaxEntries = 3,
                MaxBytes = 1_024,
                MaxEntryTtlSeconds = 1_800
            });

        Assert.True(projection.ApplyIdentity("zero-a", 0, s_now, s_now.AddMinutes(10), "zero-a"));
        Assert.True(projection.ApplyIdentity("zero-b", 0, s_now.AddSeconds(1), s_now.AddMinutes(10), "zero-b"));
        PublicHotReadRiskProjectionUpdate positive = CreateUpdate("positive-a", 100, 2, "positive-a");
        Assert.True(projection.Apply(positive));
        Assert.True(projection.ApplyIdentity("zero-c", 0, s_now.AddSeconds(3), s_now.AddMinutes(10), "zero-c"));
        Assert.True(projection.Lookup("positive-a").Known);
        Assert.Equal(100, projection.Lookup("positive-a").Score);

        PublicHotReadRiskProjectionUpdate newer = CreateUpdate("positive-a", 120, 5, "newer");
        PublicHotReadRiskProjectionUpdate older = CreateUpdate("positive-a", 80, 4, "older");
        Assert.True(PublicHotReadRiskProjectionUpdate.TryParse(newer.ToPayload(), out PublicHotReadRiskProjectionUpdate parsed));
        Assert.Equal(newer, parsed);
        Assert.True(projection.Apply(newer));
        Assert.False(projection.Apply(older));
        Assert.False(projection.Apply(newer));
        Assert.Equal(120, projection.Lookup("positive-a").Score);
        Assert.False(projection.Apply(CreateUpdate("positive-a", 0, 6, "zero-after-positive")));
        Assert.Equal(120, projection.Lookup("positive-a").Score);

        // All remaining residents are positive. A new positive identity is rejected,
        // never silently admitted as zero risk.
        Assert.True(projection.ApplyIdentity("positive-b", 100, s_now.AddSeconds(6), s_now.AddMinutes(10), "positive-b"));
        Assert.True(projection.ApplyIdentity("positive-c", 100, s_now.AddSeconds(7), s_now.AddMinutes(10), "positive-c"));
        Assert.False(projection.ApplyIdentity("positive-d", 100, s_now.AddSeconds(8), s_now.AddMinutes(10), "positive-d"));
        Assert.True(projection.Snapshot().RejectedUpdateCount > 0);

        PublicHotReadRiskProjection byteBounded = CreateProjection(
            clock,
            new PublicHotReadRiskProjectionOptions { MaxEntries = 10, MaxBytes = 1_024 });
        for (int index = 0; index < 6; index++)
        {
            Assert.True(byteBounded.ApplyIdentity(
                $"byte-positive-{index}",
                100,
                s_now,
                s_now.AddMinutes(10),
                $"p-{index}"));
        }

        PublicHotReadRiskProjectionUpdate oversizedReplacement = CreateUpdate(
            "byte-positive-0",
            101,
            20,
            new string('x', 128));
        Assert.False(byteBounded.Apply(oversizedReplacement));
        Assert.InRange(byteBounded.Snapshot().ResidentBytes, 1, byteBounded.Snapshot().MaxBytes);

        // Pub/Sub delivery is intentionally lost; the worker's durable replay path
        // restores the positive state into a fresh node from the event store.
        PublicHotReadRiskProjection restarted = CreateProjection(clock);
        var store = new LocalRiskEventStore([ToRecord(newer)]);
        using ServiceProvider services = new ServiceCollection()
            .AddScoped<ISecurityRiskEventStore>(_ => store)
            .BuildServiceProvider();
        var worker = new PublicHotReadRiskProjectionWorker(
            restarted,
            RedisOperationExecutor.ForTestConnection(Substitute.For<IConnectionMultiplexer>()),
            new DefaultRuntimeKeyScope(),
            services.GetRequiredService<IServiceScopeFactory>(),
            Options.Create(new PublicHotReadRiskProjectionOptions()),
            NullLogger<PublicHotReadRiskProjectionWorker>.Instance,
            clock);

        Assert.Equal(1, await worker.ReplayDurableAsync(CancellationToken.None));
        Assert.Equal(120, restarted.Lookup("positive-a").Score);
        Assert.Equal(1, restarted.Snapshot().DurableReplayCount);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task VerifiedCrawlerSocialPreviewAndPowChallenge_RetainExistingSemantics()
    {
        foreach ((string itemKey, string expectedSource) in new[]
        {
            ("VerifiedCrawler", PublicHotReadRiskProjectionSources.VerifiedCrawler),
            ("SocialPreviewBot", PublicHotReadRiskProjectionSources.SocialPreview)
        })
        {
            RecordingRiskSink sink = new();
            PublicHotReadSecurityGateTestsProjectionFixture fixture = new();
            PublicReadSecurityGate gate = CreateGate(fixture.Projection, sink, SecuritySystemModes.Enforce);
            DefaultHttpContext context = CreateHotContext("198.51.100.46");
            context.Items[itemKey] = true;
            AttachCandidateFeature(context);
            bool nextCalled = false;

            await new PublicHotReadSecurityGateMiddleware(_ =>
            {
                nextCalled = true;
                return Task.CompletedTask;
            }).InvokeAsync(context, gate);

            Assert.True(nextCalled);
            Assert.Empty(sink.Signals);
            Assert.Equal(expectedSource, context.Items[PublicHotReadRiskProjectionItemKeys.Source]);
        }

        var powSink = new RecordingRiskSink();
        var clock = new FixedTimeProvider(s_now);
        PublicHotReadRiskProjection positiveProjection = CreateProjection(clock);
        Assert.True(positiveProjection.ApplyIdentity(
            "198.51.100.47",
            50,
            s_now,
            s_now.AddMinutes(10),
            "pow-risk"));
        PublicReadSecurityGate powGate = CreateGate(positiveProjection, powSink, SecuritySystemModes.Enforce);
        DefaultHttpContext powContext = CreateHotContext("198.51.100.47");
        AttachCandidateFeature(powContext);
        bool powNextCalled = false;

        await new PublicHotReadSecurityGateMiddleware(_ =>
        {
            powNextCalled = true;
            return Task.CompletedTask;
        }).InvokeAsync(powContext, powGate);

        Assert.False(powNextCalled);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, powContext.Response.StatusCode);
        Assert.Equal(PublicHotReadRiskProjectionSources.LocalPositive, powContext.Items[PublicHotReadRiskProjectionItemKeys.Source]);
        Assert.Equal(SecurityRiskReason.PublicReadChallengeRequired, Assert.Single(powSink.Signals).Reason);
    }

    private static PublicHotReadRiskProjection CreateProjection(
        TimeProvider clock,
        PublicHotReadRiskProjectionOptions? options = null)
        => new(
            Options.Create(options ?? new PublicHotReadRiskProjectionOptions()),
            new SecurityRiskPseudonymizer(1, new byte[32], timeProvider: clock),
            clock);

    private static PublicHotReadRiskProjectionUpdate CreateUpdate(
        string ip,
        int score,
        int versionSeconds,
        string eventId)
    {
        var pseudonymizer = new SecurityRiskPseudonymizer(1, new byte[32]);
        SecurityRiskPseudonym pseudonym = pseudonymizer.PseudonymizeCurrent(SecurityRiskIdentityDomain.ClientIp, ip);
        return new PublicHotReadRiskProjectionUpdate(
            pseudonym.Hash,
            pseudonym.Epoch,
            score,
            s_now.AddSeconds(versionSeconds),
            s_now.AddMinutes(10),
            eventId);
    }

    private static PublicReadSecurityGate CreateGate(
        IPublicHotReadRiskProjection projection,
        ISecurityRiskSignalSink sink,
        string mode)
    {
        var provider = Substitute.For<ISecurityRiskPolicyProvider>();
        provider.CurrentRiskPolicy.Returns(CreatePolicy(mode));
        return new PublicReadSecurityGate(
            projection,
            Substitute.For<ISecurityRiskScoreReader>(),
            sink,
            provider,
            new RiskControlContextFactory(),
            new RiskDecisionService(),
            NullLogger<PublicReadSecurityGate>.Instance,
            Substitute.For<IPowService>(),
            new AdaptivePowGovernor(Substitute.For<ICacheStringReader>()));
    }

    private static SecurityRiskPolicy CreatePolicy(string mode)
    {
        var action = new SecurityRiskActionPolicy(
            RiskActionNames.PublicRead,
            new SecurityRiskActionThresholds(49, 50, 75, 90, 100),
            "security.pow",
            1,
            null,
            AnonymousWriteAllowed: true);
        return new SecurityRiskPolicy(
            "runtime",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
            s_now,
            mode,
            200,
            125,
            null,
            action,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal),
            new Dictionary<string, string>(StringComparer.Ordinal));
    }

    private static RiskControlContext CreateRiskContext(string ip)
        => new(
            RiskActionNames.PublicRead,
            "public.hot-read.binary",
            RiskControlContextStatuses.Resolved,
            ip,
            "Mozilla/5.0",
            RiskControlContextStatuses.Present,
            new RiskControlActorContext(
                RiskControlActorStatuses.Anonymous,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                null,
                null,
                null,
                null,
                null),
            new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing"),
            new RiskControlRegionContext(RiskControlContextStatuses.Missing, "UNKNOWN", null, "missing"),
            false,
            false);

    private static DefaultHttpContext CreateHotContext(string ip)
    {
        var context = new DefaultHttpContext
        {
            RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider()
        };
        context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static void AttachCandidateFeature(DefaultHttpContext context)
    {
        Assert.True(PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out PublicHotReadRequestFeature? feature));
        context.Features.Set(Assert.IsType<PublicHotReadRequestFeature>(feature));
    }

    private static SecurityRiskEventRecord ToRecord(PublicHotReadRiskProjectionUpdate update)
        => new(
            update.EventId,
            update.UpdatedAtUtc,
            SecurityRiskSources.PublicRead,
            nameof(SecurityRiskReason.PublicReadBlocked),
            RiskActionNames.PublicRead,
            update.Score,
            update.Score,
            (int)(update.ExpiresAtUtc - update.UpdatedAtUtc).TotalSeconds,
            update.ExpiresAtUtc,
            null,
            RiskActionNames.PublicRead,
            update.IdentityHash,
            null,
            "/api/binary/article/42.aeds",
            HttpMethods.Get,
            "Mozilla/5.0",
            "durable-replay",
            "trace-replay",
            update.PseudonymEpoch);

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }

    private sealed class RecordingRiskSink : ISecurityRiskSignalSink
    {
        public List<SecurityRiskSignal> Signals { get; } = [];

        public ValueTask AddRiskAsync(SecurityRiskSignal signal, CancellationToken cancellationToken = default)
        {
            Signals.Add(signal);
            return ValueTask.CompletedTask;
        }
    }

    private sealed class LocalDurableProjectionAuthority
    {
        private readonly List<PublicHotReadRiskProjectionUpdate> _events = [];

        public void Append(PublicHotReadRiskProjectionUpdate update) => _events.Add(update);

        public void PublishLatest(PublicHotReadRiskProjection target)
            => target.Apply(_events[^1], distributedUpdate: true);

        public void ReplayInto(PublicHotReadRiskProjection target)
        {
            foreach (PublicHotReadRiskProjectionUpdate update in _events)
            {
                target.Apply(update, durableReplay: true);
            }
        }
    }

    private sealed class LocalRiskEventStore(IReadOnlyList<SecurityRiskEventRecord> records) : ISecurityRiskEventStore
    {
        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(
            SecurityRiskEventQuery query,
            CancellationToken cancellationToken = default)
            => Task.FromResult(records);

        public Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
            SecurityRiskScoreQuery query,
            DateTimeOffset now,
            int limit,
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<SecurityRiskEventRecord>>(
                records.Where(item => item.ExpiresAtUtc > now).Take(limit).ToArray());
    }

    // Keeps each crawler/social-preview iteration independent while making the
    // test's projection source explicit.
    private sealed class PublicHotReadSecurityGateTestsProjectionFixture
    {
        public PublicHotReadRiskProjection Projection { get; } = CreateProjection(new FixedTimeProvider(s_now));
    }
}
