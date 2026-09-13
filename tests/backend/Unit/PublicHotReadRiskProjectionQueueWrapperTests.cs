using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Security;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicHotReadRiskProjectionQueueWrapperTests
{
    private static readonly DateTimeOffset s_now = new(2026, 9, 13, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void QueueFullAndClosed_RetainExactDurableReplayDisposition()
    {
        using var fixture = new WorkerFixture(capacity: 1);

        Assert.True(fixture.Worker.TryEnqueueRemote("first"));
        Assert.False(fixture.Worker.TryEnqueueRemote("overflow"));

        PublicHotReadRiskProjectionRemoteQueueSnapshot saturated = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(1, saturated.QueuedCount);
        Assert.Equal(0, saturated.InFlightCount);
        Assert.Equal(1, saturated.DurablePendingCount);
        Assert.Equal(0, saturated.TerminalFailureCount);
        Assert.Equal("queue-full-or-closed", saturated.LastFailureReason);

        Assert.True(fixture.Worker.TryCompleteRemoteQueue());
        Assert.False(fixture.Worker.TryEnqueueRemote("closed"));
        PublicHotReadRiskProjectionRemoteQueueSnapshot closed = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(1, closed.QueuedCount);
        Assert.Equal(1, closed.DurablePendingCount);
        Assert.True(closed.Generation >= saturated.Generation);
        Assert.True(closed.Sequence > saturated.Sequence);
    }

    [Fact]
    public void DequeueAndWorkerFailure_KeepInFlightAndReplayObligationObservable()
    {
        using var fixture = new WorkerFixture(capacity: 1);
        Assert.True(fixture.Worker.TryEnqueueRemote("payload"));

        Assert.True(fixture.Worker.TryBeginRemoteDelivery(out RedisValue payload));
        Assert.Equal("payload", (string?)payload);
        PublicHotReadRiskProjectionRemoteQueueSnapshot active = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(0, active.QueuedCount);
        Assert.Equal(1, active.InFlightCount);

        var participant = new PublicHotReadRiskProjectionBoundedQueueDrainParticipant(
            BoundedQueueDeliveryCatalog.Embedded,
            fixture.Worker,
            fixture.TimeProvider);
        BoundedQueueParticipantReceipt activeReceipt = participant.Observe("owner-test");
        Assert.Contains("inFlight=1", activeReceipt.Blockers);

        fixture.Worker.CompleteRemoteDelivery(completed: false, "worker-exception");
        PublicHotReadRiskProjectionRemoteQueueSnapshot failed = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(0, failed.InFlightCount);
        Assert.Equal(1, failed.DurablePendingCount);
        Assert.Equal("worker-exception", failed.LastFailureReason);

        BoundedQueueParticipantReceipt failedReceipt = participant.Observe("owner-test");
        Assert.False(BoundedQueueDrainEvaluation.ParticipantComplete(failedReceipt));
        Assert.Equal("postcondition_unknown", failedReceipt.ErrorCode);
        Assert.Contains("durablePending=1", failedReceipt.Blockers);
    }

    [Fact]
    public async Task Cancellation_WithQueuedWorkRetainsReplayForRestart()
    {
        using var fixture = new WorkerFixture(capacity: 1);
        Assert.True(fixture.Worker.TryEnqueueRemote("queued-before-cancel"));
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Worker.DrainRemoteAsync(cancellation.Token));

        PublicHotReadRiskProjectionRemoteQueueSnapshot snapshot = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(1, snapshot.QueuedCount);
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(1, snapshot.DurablePendingCount);
        Assert.Equal("remote-drain-cancelled", snapshot.LastFailureReason);
    }

    [Fact]
    public async Task DurableReplayFailure_BlocksQualificationUntilExactRecoverySucceeds()
    {
        using var fixture = new WorkerFixture(capacity: 1);
        PublicHotReadRiskProjectionUpdate update = fixture.CreateUpdate("198.51.100.73", score: 100, "risk-event");
        fixture.Store.ReadFailure = new IOException("store unavailable");
        Assert.True(fixture.Worker.TryCompleteRemoteQueue());
        Assert.False(fixture.Worker.TryEnqueueRemote(update.ToPayload()));

        Assert.Equal(0, await fixture.Worker.ReplayDurableAsync(CancellationToken.None));
        PublicHotReadRiskProjectionRemoteQueueSnapshot failed = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(1, failed.DurablePendingCount);
        Assert.Equal(1, failed.TerminalFailureCount);
        Assert.Contains("durable-replay-failed", failed.LastFailureReason, StringComparison.Ordinal);

        var participant = new PublicHotReadRiskProjectionBoundedQueueDrainParticipant(
            BoundedQueueDeliveryCatalog.Embedded,
            fixture.Worker,
            fixture.TimeProvider);
        BoundedQueueParticipantReceipt failedReceipt = participant.Observe("replay-test");
        Assert.Equal("commit_postcondition_failed", failedReceipt.ErrorCode);
        Assert.Equal("failed", BoundedQueueDrainEvaluation.Judge(false, failedReceipt.ErrorCode, [failedReceipt]).Health);

        fixture.Store.ReadFailure = null;
        fixture.Store.Records = [fixture.ToRecord(update)];
        Assert.Equal(1, await fixture.Worker.ReplayDurableAsync(CancellationToken.None));

        PublicHotReadRiskProjectionRemoteQueueSnapshot recovered = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(0, recovered.DurablePendingCount);
        Assert.Equal(0, recovered.TerminalFailureCount);
        Assert.Null(recovered.LastFailureReason);
        Assert.Equal(100, fixture.Projection.Lookup("198.51.100.73").Score);
        Assert.True(BoundedQueueDrainEvaluation.ParticipantComplete(participant.Observe("replay-test")));
    }

    [Fact]
    public async Task Restart_ReplaysDurableSourceWithoutDependingOnTheLostChannelItem()
    {
        using var first = new WorkerFixture(capacity: 1);
        PublicHotReadRiskProjectionUpdate update = first.CreateUpdate("198.51.100.74", score: 75, "restart-event");
        first.Store.Records = [first.ToRecord(update)];
        Assert.True(first.Worker.TryEnqueueRemote(update.ToPayload()));
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            first.Worker.DrainRemoteAsync(cancellation.Token));

        using var restarted = new WorkerFixture(capacity: 1, first.Store);
        Assert.Equal(1, await restarted.Worker.ReplayDurableAsync(CancellationToken.None));
        Assert.Equal(75, restarted.Projection.Lookup("198.51.100.74").Score);
        PublicHotReadRiskProjectionRemoteQueueSnapshot snapshot = restarted.Worker.RemoteQueueSnapshot();
        Assert.Equal(0, snapshot.QueuedCount);
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(0, snapshot.DurablePendingCount);
        Assert.Equal(0, snapshot.TerminalFailureCount);
    }

    [Fact]
    public async Task ConcurrentReplay_DoesNotClearANewerAdmissionFailure()
    {
        using var fixture = new WorkerFixture(capacity: 1);
        fixture.Store.ReadStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Store.ReleaseRead = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        Task<int> replay = fixture.Worker.ReplayDurableAsync(CancellationToken.None);
        await fixture.Store.ReadStarted.Task;

        Assert.True(fixture.Worker.TryCompleteRemoteQueue());
        Assert.False(fixture.Worker.TryEnqueueRemote("newer-rejected-item"));
        PublicHotReadRiskProjectionRemoteQueueSnapshot pending = fixture.Worker.RemoteQueueSnapshot();

        fixture.Store.ReleaseRead.SetResult();
        Assert.Equal(0, await replay);

        PublicHotReadRiskProjectionRemoteQueueSnapshot afterStaleReplay = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(1, afterStaleReplay.DurablePendingCount);
        Assert.Equal("queue-full-or-closed", afterStaleReplay.LastFailureReason);
        Assert.Equal(pending.Generation, afterStaleReplay.Generation);
    }

    [Fact]
    public void QueueTransitionsAndSnapshot_ShareOneOwnerStateLock()
    {
        using var fixture = new WorkerFixture(capacity: 1);
        object stateGate = typeof(PublicHotReadRiskProjectionWorker)
            .GetField("_remoteQueueStateGate", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(fixture.Worker)!;

        AssertUsesOwnerStateLock(stateGate, () => Assert.True(fixture.Worker.TryEnqueueRemote("payload")));
        AssertUsesOwnerStateLock(stateGate, () => Assert.True(fixture.Worker.TryBeginRemoteDelivery(out _)));
        AssertUsesOwnerStateLock(stateGate, () => fixture.Worker.CompleteRemoteDelivery(false, "worker-failure"));
        AssertUsesOwnerStateLock(stateGate, () => fixture.Worker.RemoteQueueSnapshot());

        PublicHotReadRiskProjectionRemoteQueueSnapshot snapshot = fixture.Worker.RemoteQueueSnapshot();
        Assert.Equal(0, snapshot.QueuedCount);
        Assert.Equal(0, snapshot.InFlightCount);
        Assert.Equal(1, snapshot.DurablePendingCount);
    }

    private static void AssertUsesOwnerStateLock(object stateGate, Action action)
    {
        using var started = new ManualResetEventSlim();
        Task? actionTask = null;
        Monitor.Enter(stateGate);
        try
        {
            actionTask = Task.Run(() =>
            {
                started.Set();
                action();
            });
            Assert.True(started.Wait(TimeSpan.FromSeconds(1)));
            Assert.False(actionTask.Wait(TimeSpan.FromMilliseconds(50)));
        }
        finally
        {
            Monitor.Exit(stateGate);
        }

        actionTask!.GetAwaiter().GetResult();
    }

    private sealed class WorkerFixture : IDisposable
    {
        private readonly SecurityRiskPseudonymizer _pseudonymizer;
        private readonly ServiceProvider _services;

        public WorkerFixture(int capacity, MutableRiskEventStore? store = null)
        {
            TimeProvider = new FixedTimeProvider(s_now);
            _pseudonymizer = new SecurityRiskPseudonymizer(1, new byte[32], timeProvider: TimeProvider);
            Projection = new PublicHotReadRiskProjection(
                Options.Create(new PublicHotReadRiskProjectionOptions()),
                _pseudonymizer,
                TimeProvider);
            Store = store ?? new MutableRiskEventStore();
            _services = new ServiceCollection()
                .AddScoped<ISecurityRiskEventStore>(_ => Store)
                .BuildServiceProvider();
            Worker = new PublicHotReadRiskProjectionWorker(
                Projection,
                Substitute.For<IConnectionMultiplexer>(),
                new DefaultRuntimeKeyScope(),
                _services.GetRequiredService<IServiceScopeFactory>(),
                Options.Create(new PublicHotReadRiskProjectionOptions
                {
                    SubscriberCapacity = capacity,
                    ReplayIntervalSeconds = 1
                }),
                NullLogger<PublicHotReadRiskProjectionWorker>.Instance,
                TimeProvider);
        }

        public FixedTimeProvider TimeProvider
        {
            get;
        }

        public PublicHotReadRiskProjection Projection
        {
            get;
        }

        public MutableRiskEventStore Store
        {
            get;
        }

        public PublicHotReadRiskProjectionWorker Worker
        {
            get;
        }

        public PublicHotReadRiskProjectionUpdate CreateUpdate(string clientIp, int score, string eventId)
        {
            SecurityRiskPseudonym pseudonym = _pseudonymizer.PseudonymizeCurrent(SecurityRiskIdentityDomain.ClientIp, clientIp);
            return new PublicHotReadRiskProjectionUpdate(
                pseudonym.Hash,
                pseudonym.Epoch,
                score,
                s_now,
                s_now.AddMinutes(10),
                eventId);
        }

        public SecurityRiskEventRecord ToRecord(PublicHotReadRiskProjectionUpdate update)
            => new(
                update.EventId,
                update.UpdatedAtUtc,
                "owner-test",
                "risk",
                "public-read",
                update.Score,
                update.Score,
                600,
                update.ExpiresAtUtc,
                null,
                null,
                update.IdentityHash,
                null,
                "/api/binary/article/1.aeds",
                HttpMethods.Get,
                "owner-test",
                null,
                "trace",
                update.PseudonymEpoch);

        public void Dispose()
        {
            Worker.Dispose();
            _services.Dispose();
        }
    }

    private sealed class MutableRiskEventStore : ISecurityRiskEventStore
    {
        public IReadOnlyList<SecurityRiskEventRecord> Records { get; set; } = [];

        public Exception? ReadFailure
        {
            get; set;
        }

        public TaskCompletionSource? ReadStarted
        {
            get; set;
        }

        public TaskCompletionSource? ReleaseRead
        {
            get; set;
        }

        public Task AppendAsync(SecurityRiskEventWrite write, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task AppendBatchAsync(IReadOnlyList<SecurityRiskEventWrite> writes, CancellationToken cancellationToken = default)
            => Task.CompletedTask;

        public Task<IReadOnlyList<SecurityRiskEventRecord>> QueryAsync(
            SecurityRiskEventQuery query,
            CancellationToken cancellationToken = default)
            => Task.FromResult(Records);

        public async Task<IReadOnlyList<SecurityRiskEventRecord>> ListActiveForScoreAsync(
            SecurityRiskScoreQuery query,
            DateTimeOffset now,
            int limit,
            CancellationToken cancellationToken = default)
        {
            ReadStarted?.SetResult();
            if (ReleaseRead is not null)
            {
                await ReleaseRead.Task.WaitAsync(cancellationToken);
            }

            if (ReadFailure is not null)
            {
                throw ReadFailure;
            }

            return Records.Where(item => item.ExpiresAtUtc > now).Take(limit).ToArray();
        }
    }

    public sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
