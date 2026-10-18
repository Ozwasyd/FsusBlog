using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminAuthenticatedRequestLifetimeTests
{
    [Fact]
    public async Task SameOwnerDifferentSessions_RevocationOnlyInvalidatesMatchingRequest()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        projection.Apply(Session(temporal, "other", "other-token"));
        var service = new AdminSessionValidationService(projection, Substitute.For<IAdminSessionTouchScheduler>());
        // Ordinary sid deliberately points elsewhere; admin provenance must use admin_sid.
        ClaimsPrincipal principal = Principal("first");
        ((ClaimsIdentity)principal.Identity!).AddClaim(new Claim("sid", "other"));
        using AdminAuthenticatedRequestLifetime first = (await service.ValidateAsync(principal, "token", default)).RequestLifetime!;
        using AdminAuthenticatedRequestLifetime other = (await service.ValidateAsync(Principal("other"), "other-token", default)).RequestLifetime!;
        Assert.True(first.IsCurrent);
        Assert.True(other.IsCurrent);
        Assert.NotEqual(first.BindingDigest, other.BindingDigest);
        Assert.DoesNotContain("token", first.BindingDigest, StringComparison.Ordinal);
        projection.Apply(Session(temporal) with
        {
            Version = 2,
            Generation = 2,
            RevokedAtUtc = temporal.BusinessEpochUtc
        });
        Assert.False(first.IsCurrent);
        Assert.True(first.Invalidated.IsCancellationRequested);
        Assert.True(other.IsCurrent);
        Assert.False(other.Invalidated.IsCancellationRequested);
    }

    [Theory]
    [InlineData("not-ready")]
    [InlineData("lag")]
    [InlineData("principal-version")]
    [InlineData("principal-disabled")]
    [InlineData("rotation")]
    [InlineData("expiry")]
    [InlineData("prune")]
    [InlineData("idle-change")]
    [InlineData("conflict")]
    public void AuthorityChanges_InvalidateRegisteredRequest(string change)
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        using AdminAuthenticatedRequestLifetime lifetime = Admit(projection);
        AdminSessionProjectionSessionUpdate session = Session(temporal);
        switch (change)
        {
            case "not-ready":
                projection.MarkNotReady("test-withdrawal");
                break;
            case "lag":
                Assert.False(projection.MarkReady(100));
                break;
            case "principal-version":
                projection.Apply(session.Principal with
                {
                    Version = 2,
                    Generation = 2
                });
                break;
            case "principal-disabled":
                projection.Apply(session.Principal with
                {
                    Status = AdminSessionProjectionPrincipalStatus.Disabled,
                    Version = 2,
                    Generation = 2
                });
                break;
            case "rotation":
                projection.Apply(session with
                {
                    AccessTokenHash = Hash("rotated"),
                    Version = 2,
                    Generation = 2
                });
                break;
            case "expiry":
                temporal.Advance(TimeSpan.FromMinutes(11));
                break;
            case "prune":
                temporal.Advance(TimeSpan.FromMinutes(11));
                projection.PruneExpiredAndRevoked();
                break;
            case "idle-change":
                projection.Apply(session with
                {
                    IdleExpiresAtUtc = temporal.BusinessEpochUtc.AddMinutes(20),
                    Version = 2,
                    Generation = 2
                });
                break;
            case "conflict":
                Assert.Equal(AdminSessionProjectionApplyStatus.Conflict, projection.Apply(session with
                {
                    AccessTokenHash = Hash("conflict")
                }).Status);
                break;
        }
        Assert.False(lifetime.IsCurrent);
        Assert.True(lifetime.Invalidated.IsCancellationRequested);
        Assert.Equal(0, projection.ActiveRequestLifetimeCount);
    }

    [Fact]
    public async Task SubscribeRevokeRace_CallbackRunsOnceAndOutsideProjectionGate()
    {
        for (int attempt = 0; attempt < 30; attempt++)
        {
            TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
            AdminSessionProjection projection = Ready(temporal);
            using AdminAuthenticatedRequestLifetime lifetime = Admit(projection);
            int calls = 0;
            bool gateFree = false;
            Task<bool>? crossThread = null;
            using var start = new ManualResetEventSlim();
            var notified = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            Task subscribe = Task.Run(async () =>
            {
                start.Wait();
                using CancellationTokenRegistration registration = lifetime.Invalidated.Register(() =>
                {
                    Interlocked.Increment(ref calls);
                    crossThread = Task.Run(() => projection.Snapshot().IsReady);
                    gateFree = crossThread.Wait(TimeSpan.FromSeconds(5));
                    notified.TrySetResult();
                });
                // Keep registration alive until cancellation is observed.
                await notified.Task.WaitAsync(TimeSpan.FromSeconds(10));
            });
            Task revoke = Task.Run(() =>
            {
                start.Wait();
                projection.Apply(Session(temporal) with
                {
                    Version = 2,
                    Generation = 2,
                    RevokedAtUtc = temporal.BusinessEpochUtc
                });
            });
            start.Set();
            await Task.WhenAll(subscribe, revoke).WaitAsync(TimeSpan.FromSeconds(10));
            Assert.Equal(1, calls);
            Assert.NotNull(crossThread);
            Assert.True(gateFree, "callback held the projection gate");
            Assert.False(lifetime.IsCurrent);
        }
    }

    [Fact]
    public void LateSubscriberAndThrowingCallback_DoNotLoseRevocationOrFailApply()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        using AdminAuthenticatedRequestLifetime lifetime = Admit(projection);
        using CancellationTokenRegistration throwing = lifetime.Invalidated.Register(() => throw new InvalidOperationException("subscriber"));
        projection.MarkNotReady("withdraw");
        int called = 0;
        using CancellationTokenRegistration late = lifetime.Invalidated.Register(() => called++);
        Assert.Equal(1, called);
        Assert.False(lifetime.IsCurrent);
    }

    [Fact]
    public void RequestAbortDisposalAndCapacity_AreBoundedAndRecycle()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        using (var aborted = new CancellationTokenSource())
        using (AdminAuthenticatedRequestLifetime lifetime = Admit(projection))
        {
            lifetime.BindRequest(aborted.Token);
            aborted.Cancel();
            lifetime.Dispose();
            Assert.False(lifetime.IsCurrent);
            Assert.Equal(0, projection.ActiveRequestLifetimeCount);
        }
        var registrations = new List<AdminAuthenticatedRequestLifetime>();
        try
        {
            for (int index = 0; index < AdminSessionProjection.MaxRequestLifetimes; index++)
            {
                registrations.Add(Admit(projection));
            }
            Assert.False(projection.ValidateForRequest("first", 7, Hash("token"), out var rejected).IsValid);
            Assert.Null(rejected);
            Assert.True(projection.Validate("first", 7, Hash("token")).IsValid);
            registrations[0].Dispose();
            using AdminAuthenticatedRequestLifetime recycled = Admit(projection);
            Assert.Equal(AdminSessionProjection.MaxRequestLifetimes, projection.ActiveRequestLifetimeCount);
        }
        finally
        {
            foreach (AdminAuthenticatedRequestLifetime registration in registrations)
            {
                registration.Dispose();
            }
        }
        Assert.Equal(0, projection.ActiveRequestLifetimeCount);
    }

    [Fact]
    public void LifetimeDeadlineAndCallerConstructedHandle_CannotAuthorize()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        using var forged = new AdminAuthenticatedRequestLifetime(projection, "caller-provided-digest");
        Assert.False(forged.IsCurrent);
        Assert.Throws<OperationCanceledException>(() => forged.RequireBinding());
        Assert.Null(AdminSessionValidationResult.Valid.RequestLifetime);
        using AdminAuthenticatedRequestLifetime admitted = Admit(projection);
        temporal.Advance(AdminSessionProjection.MaxRequestLifetime);
        Assert.False(admitted.IsCurrent);
        Assert.True(projection.Validate("first", 7, Hash("token")).IsValid);
    }

    [Fact]
    public async Task ActualReceivedDistributedUpdate_InvalidatesOriginalRegistration()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        using AdminAuthenticatedRequestLifetime lifetime = Admit(projection);
        // Admin event dispatch uses only this original projection; unrelated lanes are deliberately absent.
        var applier = new DistributedInvalidationLocalApplier(null!, null!, null!, null!, null!, null!, null!, null!,
            NullLogger<DistributedInvalidationLocalApplier>.Instance, adminSessionProjection: projection);
        AdminSessionProjectionSessionUpdate revoked = Session(temporal) with
        {
            Version = 2,
            Generation = 2,
            RevokedAtUtc = temporal.BusinessEpochUtc
        };
        DistributedInvalidationEvent received = DistributedInvalidationEvent.Create("received-update",
            DistributedInvalidationEventKinds.AdminSessionProjectionMutation, "remote-node", "test",
            [], [], [AdminSessionProjectionEventCodec.Format(revoked)], "test-trace", temporal.BusinessClock);
        Assert.True(lifetime.IsCurrent);
        var options = new DistributedInvalidationOptions
        {
            RuntimeMode = RuntimeModeKind.StaticRole,
            NodeId = "receiver",
            Channel = "test-channel",
            Topology = DistributedInvalidationTopologyManifest.Create("test-channel", ["receiver"]),
            ApplyRetryCount = 1
        };
        IRuntimeKeyScope scope = Substitute.For<IRuntimeKeyScope>();
        scope.ScopeToken.Returns("test");
        var factory = new DistributedInvalidationEventFactory(options, scope, temporal.BusinessClock);
        IDistributedInvalidationDeliveryLedger ledger = Substitute.For<IDistributedInvalidationDeliveryLedger>();
        ledger.ReceiveAsync(Arg.Any<DistributedInvalidationEvent>(), "receiver", Arg.Any<CancellationToken>())
            .Returns(new DistributedInvalidationInboxReceipt(false, false, false, DistributedInvalidationInboxApplyState.Pending));
        ledger.TryBeginApplyAsync(Arg.Any<DistributedInvalidationEvent>(), "receiver", Arg.Any<CancellationToken>()).Returns(true);
        await using ServiceProvider services = new ServiceCollection().AddSingleton(ledger).BuildServiceProvider();
        using var bus = new DistributedInvalidationBus(Substitute.For<IDistributedInvalidationTransport>(), applier,
            factory, options, new DistributedInvalidationRuntimeState(temporal.BusinessClock), new CacheInvalidationRuntimeState(),
            NullLogger<DistributedInvalidationBus>.Instance, services.GetRequiredService<IServiceScopeFactory>());
        await bus.HandlePayloadAsync(JsonSerializer.Serialize(received), default);
        await ledger.Received(1).RecordApplyAsync(Arg.Any<DistributedInvalidationEvent>(), "receiver",
            DistributedInvalidationInboxApplyState.Applied, null, 2, Arg.Any<CancellationToken>());
        Assert.False(lifetime.IsCurrent);
        Assert.True(lifetime.Invalidated.IsCancellationRequested);
    }

    [Fact]
    public async Task SchedulerAndTimerFailures_ReleaseMintedRegistration()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        IAdminSessionTouchScheduler touches = Substitute.For<IAdminSessionTouchScheduler>();
        touches.TrySchedule(Arg.Any<AdminSessionTouchRequest>()).Returns(_ => throw new InvalidOperationException("scheduler"));
        var service = new AdminSessionValidationService(projection, touches);
        await Assert.ThrowsAsync<InvalidOperationException>(() => service.ValidateAsync(Principal("first"), "token", default));
        Assert.Equal(0, projection.ActiveRequestLifetimeCount);
        var failing = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024), new ThrowingTimerClock(temporal.BusinessEpochUtc));
        failing.Apply(Session(temporal));
        failing.MarkReady(1);
        Assert.Throws<InvalidOperationException>(() => failing.ValidateForRequest("first", 7, Hash("token"), out _));
        Assert.Equal(0, failing.ActiveRequestLifetimeCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExpiryTimer_CancelsWithoutCurrentnessProbe_AndReleasesTimer(bool absolute)
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        var clock = new ControlledTimerClock(temporal.BusinessEpochUtc);
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024), clock);
        AdminSessionProjectionSessionUpdate session = Session(temporal);
        DateTimeOffset expiry = temporal.BusinessEpochUtc.AddSeconds(20);
        session = absolute ? session with
        {
            AbsoluteExpiresAtUtc = expiry
        } : session with
        {
            IdleExpiresAtUtc = expiry
        };
        projection.Apply(session);
        projection.MarkReady(1);
        using AdminAuthenticatedRequestLifetime lifetime = Admit(projection);
        Assert.Equal(TimeSpan.FromSeconds(20), clock.Timer!.DueTime);
        int calls = 0;
        using CancellationTokenRegistration subscription = lifetime.Invalidated.Register(() => calls++);
        clock.AdvanceAndFire(TimeSpan.FromSeconds(20));
        Assert.Equal(1, calls);
        Assert.True(lifetime.Invalidated.IsCancellationRequested);
        Assert.True(clock.Timer.Disposed);
        Assert.Equal(0, projection.ActiveRequestLifetimeCount);
    }

    [Fact]
    public void TokenExpiryCapsLifetime_AndDuplicateOrStaleUpdatesPreserveIt()
    {
        TestTemporalContext temporal = TestTemporalContext.CreateCanonical();
        AdminSessionProjection projection = Ready(temporal);
        using AdminAuthenticatedRequestLifetime lifetime = Admit(projection);
        projection.Apply(Session(temporal));
        Assert.True(lifetime.IsCurrent);
        lifetime.RestrictToTokenExpiry(temporal.BusinessEpochUtc.AddSeconds(10));
        temporal.Advance(TimeSpan.FromSeconds(10));
        Assert.False(lifetime.IsCurrent);
    }

    private sealed class ThrowingTimerClock(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
            => throw new InvalidOperationException("timer creation failed");
    }

    private sealed class ControlledTimerClock(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;
        internal ControlledTimer? Timer
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow() => _now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
            => Timer = new ControlledTimer(callback, state, dueTime);
        internal void AdvanceAndFire(TimeSpan delta)
        {
            _now += delta;
            Timer!.Fire();
        }
    }

    private sealed class ControlledTimer(TimerCallback callback, object? state, TimeSpan dueTime) : ITimer
    {
        internal TimeSpan DueTime { get; private set; } = dueTime;
        internal bool Disposed
        {
            get; private set;
        }
        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            DueTime = dueTime;
            return !Disposed;
        }
        public void Dispose() => Disposed = true;
        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
        internal void Fire()
        {
            if (!Disposed)
            {
                callback(state);
            }
        }
    }

    internal static AdminSessionProjection Ready(TestTemporalContext temporal)
    {
        var projection = new AdminSessionProjection(new AdminSessionProjectionLimits(16, 16, 1024 * 1024), temporal.BusinessClock);
        Assert.True(projection.Apply(Session(temporal)).Accepted);
        Assert.True(projection.MarkReady(1));
        return projection;
    }

    internal static AdminAuthenticatedRequestLifetime Admit(AdminSessionProjection projection)
    {
        Assert.True(projection.ValidateForRequest("first", 7, Hash("token"), out AdminAuthenticatedRequestLifetime? lifetime).IsValid);
        return Assert.IsType<AdminAuthenticatedRequestLifetime>(lifetime);
    }

    internal static AdminSessionProjectionSessionUpdate Session(TestTemporalContext temporal, string id = "first", string token = "token")
        => new(id, 7, Hash(token), null, temporal.BusinessEpochUtc.AddMinutes(10), temporal.BusinessEpochUtc.AddHours(1),
            1, 1, new AdminSessionProjectionPrincipalUpdate(7, AdminSessionProjectionPrincipalStatus.Active, 1, 1));

    internal static ClaimsPrincipal Principal(string sessionId)
        => new(new ClaimsIdentity([new Claim("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new Claim("admin_id", "7"), new Claim("admin_sid", sessionId)], "test"));

    internal static byte[] Hash(string token) => SHA256.HashData(Encoding.UTF8.GetBytes(token));
}
