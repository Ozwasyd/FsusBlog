using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminSessionValidationServiceTests
{
    [Fact]
    public async Task ValidateAsync_UsesOnlyReadyLocalProjection_AndFailsClosedForUnknown()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var clock = new ManualTimeProvider(now);
        AdminSessionProjection projection = CreateProjection(clock);
        using AdminSessionTouchScheduler touches = CreateTouchScheduler(clock, capacity: 8, tracking: 8);
        var service = new AdminSessionValidationService(projection, touches);

        AdminSessionValidationResult cold = await service.ValidateAsync(Principal(1, "sid"), "token", default);
        Assert.False(cold.IsValid);
        Assert.Equal(AdminSessionProjectionReasons.NotReady, cold.Reason);

        ApplyActive(projection, "sid", "token", now);
        Assert.True(projection.MarkReady(1));
        Assert.True((await service.ValidateAsync(Principal(1, "sid"), "token", default)).IsValid);

        AdminSessionValidationResult unknown = await service.ValidateAsync(Principal(1, "unknown"), "token", default);
        Assert.False(unknown.IsValid);
        Assert.Equal(AdminSessionProjectionReasons.UnknownSession, unknown.Reason);
        Assert.Equal(0, projection.Snapshot().AuthorityReadCount);
    }

    [Fact]
    public async Task ValidateAsync_OneThousandConcurrentReads_DoNotReadAuthority_AndCoalesceTouch()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var clock = new ManualTimeProvider(now);
        AdminSessionProjection projection = CreateProjection(clock);
        ApplyActive(projection, "sid-hot", "token", now);
        Assert.True(projection.MarkReady(1));
        using AdminSessionTouchScheduler touches = CreateTouchScheduler(clock, capacity: 16, tracking: 16);
        var service = new AdminSessionValidationService(projection, touches);
        ClaimsPrincipal principal = Principal(1, "sid-hot");

        AdminSessionValidationResult[] results = await Task.WhenAll(
            Enumerable.Range(0, 1000).Select(_ => service.ValidateAsync(principal, "token", default)));

        Assert.All(results, static result => Assert.True(result.IsValid));
        Assert.Equal(0, projection.Snapshot().AuthorityReadCount);
        AdminSessionTouchRuntimeSnapshot touch = touches.Snapshot();
        Assert.Equal(1, touch.EnqueuedCount);
        Assert.Equal(999, touch.DebouncedCount);
        Assert.Equal(1, touch.QueueEntries);
        Assert.DoesNotContain(
            typeof(AdminSessionValidationService).GetConstructors().Single().GetParameters(),
            static parameter => parameter.ParameterType.Name.Contains("SqlSugar", StringComparison.Ordinal)
                || parameter.ParameterType.Name.Contains("Redis", StringComparison.Ordinal)
                || parameter.ParameterType.Name.Contains("MemoryCache", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ValidateAsync_PreservesTokenExpiryAndPrincipalChecks()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var clock = new ManualTimeProvider(now);
        AdminSessionProjection projection = CreateProjection(clock);
        ApplyActive(projection, "sid", "token", now);
        Assert.True(projection.MarkReady(1));
        using AdminSessionTouchScheduler touches = CreateTouchScheduler(clock, capacity: 8, tracking: 8);
        var service = new AdminSessionValidationService(projection, touches);

        Assert.Equal(
            AdminSessionProjectionReasons.TokenMismatch,
            (await service.ValidateAsync(Principal(1, "sid"), "wrong", default)).Reason);
        Assert.Equal(
            AdminSessionProjectionReasons.PrincipalMismatch,
            (await service.ValidateAsync(Principal(2, "sid"), "token", default)).Reason);

        clock.Advance(TimeSpan.FromMinutes(11));
        Assert.Equal(
            AdminSessionProjectionReasons.IdleExpired,
            (await service.ValidateAsync(Principal(1, "sid"), "token", default)).Reason);
    }

    [Fact]
    public void TouchScheduler_TrackingAndQueueAreStrictlyBounded()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        var clock = new ManualTimeProvider(now);
        using AdminSessionTouchScheduler scheduler = CreateTouchScheduler(clock, capacity: 3, tracking: 2);
        byte[] hash = Hash("token");

        Assert.True(scheduler.TrySchedule(Touch("a", hash, now)));
        Assert.True(scheduler.TrySchedule(Touch("b", hash, now)));
        Assert.False(scheduler.TrySchedule(Touch("c", hash, now)));
        AdminSessionTouchRuntimeSnapshot snapshot = scheduler.Snapshot();
        Assert.Equal(2, snapshot.QueueEntries);
        Assert.Equal(2, snapshot.TrackingEntries);
        Assert.Equal(3, snapshot.QueueCapacity);
        Assert.Equal(2, snapshot.MaxTrackingEntries);
        Assert.True(snapshot.TrackingBytes > 0);

        clock.Advance(TimeSpan.FromHours(3));
        Assert.Equal(0, scheduler.Snapshot().TrackingEntries);
        bool recycled = scheduler.TrySchedule(Touch("c", hash, clock.GetUtcNow()));
        Assert.True(recycled, $"touch scheduler did not recycle: {scheduler.Snapshot()}");
        Assert.Equal(1, scheduler.Snapshot().TrackingEntries);
    }

    [Fact]
    public void DistributedCodec_RoundTripsSessionAndPrincipal_AndRejectsCorruption()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        AdminSessionProjectionSessionUpdate session = Session("sid", "token", now);
        string sessionTarget = AdminSessionProjectionEventCodec.Format(session);
        Assert.True(AdminSessionProjectionEventCodec.TryParse(sessionTarget, out var parsedSession, out var parsedPrincipal));
        Assert.True(parsedSession.HasValue);
        Assert.Equal(session.SessionId, parsedSession.Value.SessionId);
        Assert.Equal(session.Version, parsedSession.Value.Version);
        Assert.True(session.AccessTokenHash.Span.SequenceEqual(parsedSession.Value.AccessTokenHash.Span));
        Assert.Null(parsedPrincipal);

        AdminSessionProjectionPrincipalUpdate principal = session.Principal with
        {
            Status = AdminSessionProjectionPrincipalStatus.Disabled,
            Version = 2,
            Generation = 2
        };
        string principalTarget = AdminSessionProjectionEventCodec.Format(principal);
        Assert.True(AdminSessionProjectionEventCodec.TryParse(principalTarget, out parsedSession, out parsedPrincipal));
        Assert.Null(parsedSession);
        Assert.Equal(principal, parsedPrincipal);
        Assert.False(AdminSessionProjectionEventCodec.TryParse(principalTarget + "x", out _, out _));
    }

    [Fact]
    public void DurableReplay_RotateRevokeDisable_IsIdempotentAndOrderIndependent()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        AdminSessionProjectionSessionUpdate created = Session("sid", "old-token", now);
        AdminSessionProjectionSessionUpdate rotated = created with
        {
            AccessTokenHash = Hash("new-token"),
            Version = 2,
            Generation = 2
        };
        AdminSessionProjectionSessionUpdate revoked = rotated with
        {
            RevokedAtUtc = now,
            Version = 3,
            Generation = 3
        };
        AdminSessionProjectionPrincipalUpdate disabled = created.Principal with
        {
            Status = AdminSessionProjectionPrincipalStatus.Disabled,
            Version = 2,
            Generation = 2
        };
        string[] durableTargets =
        [
            AdminSessionProjectionEventCodec.Format(revoked),
            AdminSessionProjectionEventCodec.Format(disabled),
            AdminSessionProjectionEventCodec.Format(rotated),
            AdminSessionProjectionEventCodec.Format(revoked)
        ];
        AdminSessionProjection projection = CreateProjection(new ManualTimeProvider(now));
        Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(created).Status);
        foreach (string target in durableTargets)
        {
            Assert.True(AdminSessionProjectionEventCodec.TryParse(target, out var session, out var principal));
            AdminSessionProjectionApplyResult result = session.HasValue
                ? projection.Apply(session.Value)
                : projection.Apply(principal!.Value);
            Assert.True(result.Accepted);
        }
        Assert.True(projection.MarkReady(3));
        Assert.False(projection.Validate("sid", 1, Hash("new-token")).IsValid);

        AdminSessionProjection restarted = CreateProjection(new ManualTimeProvider(now));
        foreach (string target in durableTargets.Reverse())
        {
            Assert.True(AdminSessionProjectionEventCodec.TryParse(target, out var session, out var principal));
            _ = session.HasValue ? restarted.Apply(session.Value) : restarted.Apply(principal!.Value);
        }
        Assert.True(restarted.MarkReady(3));
        Assert.False(restarted.Validate("sid", 1, Hash("new-token")).IsValid);
    }

    [Fact]
    public async Task DurableReplay_SourceNodeAdminEvent_IsAppliedInsteadOfPreAckIgnored()
    {
        const string NodeId = "node-a";
        const string RuntimeScope = "test";
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = NodeId,
            Channel = "test-channel",
            Topology = DistributedInvalidationTopologyManifest.Create("test-channel", [NodeId]),
            ApplyRetryCount = 1,
            ApplyRetryDelay = TimeSpan.FromMilliseconds(1),
            RecoveryReplayInterval = TimeSpan.FromSeconds(1),
            DedupeCapacity = 128,
            IngressCapacity = 8
        };
        IRuntimeKeyScope keyScope = Substitute.For<IRuntimeKeyScope>();
        keyScope.ScopeToken.Returns(RuntimeScope);
        var eventFactory = new DistributedInvalidationEventFactory(options, keyScope, TimeProvider.System);
        IDistributedInvalidationDeliveryLedger ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReceiveAsync(Arg.Any<DistributedInvalidationEvent>(), NodeId, Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(false, false, false, DistributedInvalidationInboxApplyState.Pending));
        ledger.TryBeginApplyAsync(Arg.Any<DistributedInvalidationEvent>(), NodeId, Arg.Any<CancellationToken>())
            .Returns(true);
        IDistributedInvalidationLocalApplier applier = Substitute.For<IDistributedInvalidationLocalApplier>();
        applier.ApplyAsync(Arg.Any<DistributedInvalidationEvent>(), Arg.Any<CancellationToken>())
            .Returns(AppliedDistributedResult());
        await using ServiceProvider services = new ServiceCollection()
            .AddSingleton(ledger)
            .BuildServiceProvider();
        var bus = new DistributedInvalidationBus(
            Substitute.For<IDistributedInvalidationTransport>(),
            applier,
            eventFactory,
            options,
            new DistributedInvalidationRuntimeState(TimeProvider.System),
            new CacheInvalidationRuntimeState(),
            NullLogger<DistributedInvalidationBus>.Instance,
            services.GetRequiredService<IServiceScopeFactory>());
        DistributedInvalidationEvent invalidation = eventFactory.Create(new DistributedInvalidationRequest(
            DistributedInvalidationEventKinds.AdminSessionProjectionMutation,
            [],
            [],
            [AdminSessionProjectionEventCodec.Format(Session("sid", "token", DateTimeOffset.UtcNow))]));

        await bus.HandlePayloadAsync(JsonSerializer.Serialize(invalidation), default);

        await applier.Received(1).ApplyAsync(
            Arg.Is<DistributedInvalidationEvent>(value => value.EventId == invalidation.EventId),
            Arg.Any<CancellationToken>());
        await ledger.Received(1).RecordApplyAsync(
            Arg.Is<DistributedInvalidationEvent>(value => value.EventId == invalidation.EventId),
            NodeId,
            DistributedInvalidationInboxApplyState.Applied,
            null,
            1,
            Arg.Any<CancellationToken>());
    }

    private static AdminSessionTouchRequest Touch(string sessionId, byte[] hash, DateTimeOffset now)
        => new(sessionId, 1, hash, now.AddHours(1), now.AddHours(2));

    private static DistributedInvalidationLocalApplyResult AppliedDistributedResult()
        => new(
            true,
            true,
            true,
            true,
            DistributedInvalidationRebuildObligationStatus.Queued,
            DistributedInvalidationLocalApplyStatus.Applied,
            null,
            1,
            0);

    private static AdminSessionTouchScheduler CreateTouchScheduler(
        TimeProvider clock,
        int capacity,
        int tracking)
        => new(
            Substitute.For<IServiceScopeFactory>(),
            new AdminSessionProjectionRuntimeOptions(
                new AdminSessionProjectionLimits(32, 32, 1024 * 1024),
                8,
                capacity,
                tracking,
                TimeSpan.FromSeconds(45),
                TimeSpan.FromMilliseconds(1),
                TimeSpan.FromMilliseconds(100)),
            clock,
            NullLogger<AdminSessionTouchScheduler>.Instance);

    private static AdminSessionProjection CreateProjection(TimeProvider clock)
        => new(new AdminSessionProjectionLimits(32, 32, 1024 * 1024), clock);

    private static void ApplyActive(
        AdminSessionProjection projection,
        string sessionId,
        string token,
        DateTimeOffset now)
        => Assert.Equal(AdminSessionProjectionApplyStatus.Applied, projection.Apply(Session(sessionId, token, now)).Status);

    private static AdminSessionProjectionSessionUpdate Session(
        string sessionId,
        string token,
        DateTimeOffset now)
        => new(
            sessionId,
            1,
            Hash(token),
            null,
            now.AddMinutes(10),
            now.AddHours(1),
            1,
            1,
            new AdminSessionProjectionPrincipalUpdate(
                1,
                AdminSessionProjectionPrincipalStatus.Active,
                1,
                1));

    private static ClaimsPrincipal Principal(long adminId, string sessionId)
        => new(new ClaimsIdentity(
        [
            new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", adminId.ToString()),
            new Claim("admin_sid", sessionId)
        ], "test"));

    private static byte[] Hash(string value)
        => SHA256.HashData(Encoding.UTF8.GetBytes(value));

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan value) => _now += value;
    }
}
