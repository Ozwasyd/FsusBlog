using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BoundedQueueDrainAggregatorTests
{
    private static readonly DateTimeOffset s_observedAt = new(2026, 9, 8, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void EmbeddedCatalog_RegistersOneUniqueAdapterPerDrainParticipant()
    {
        BoundedQueueDeliveryCatalog catalog = BoundedQueueDeliveryCatalog.Embedded;

        Assert.NotEmpty(catalog.DrainParticipants);
        Assert.Equal(catalog.DrainParticipants.Count, catalog.DrainParticipants
            .Select(static item => item.ParticipantAdapterToken)
            .Distinct(StringComparer.Ordinal)
            .Count());
        Assert.All(catalog.DrainParticipants, static item =>
        {
            Assert.True(item.DrainParticipant);
            Assert.False(string.IsNullOrWhiteSpace(item.ParticipantAdapterToken));
        });
    }

    [Fact]
    public void Observe_RequiresAllCountsAndCommitPostcondition()
    {
        var participant = new TestParticipant("required-queue", "RequiredAdapter");
        var aggregator = CreateAggregator(
            new("required-queue", "required", true, "RequiredAdapter", "blocks qualification"),
            participant);

        participant.Set(queued: 0, inFlight: 1);
        AssertBlocked(aggregator.Observe(), "inFlight=1");

        participant.Set(queued: 0, inFlight: 0, durablePending: 1);
        AssertBlocked(aggregator.Observe(), "durablePending=1");

        participant.Set(durablePending: 0, terminalFailures: 1, postcondition: BoundedQueueCommitPostcondition.Failed);
        BoundedQueueDrainAggregateReceipt failed = aggregator.Observe();
        Assert.False(failed.Complete);
        Assert.Equal("commit_postcondition_failed", failed.ErrorCode);

        participant.Set(terminalFailures: 0, postcondition: BoundedQueueCommitPostcondition.Unknown);
        BoundedQueueDrainAggregateReceipt unknown = aggregator.Observe();
        Assert.False(unknown.Complete);
        Assert.Equal("postcondition_unknown", unknown.ErrorCode);

        participant.Set(postcondition: BoundedQueueCommitPostcondition.Success);
        BoundedQueueDrainAggregateReceipt complete = aggregator.Observe();
        Assert.True(complete.Complete);
        Assert.Equal("ok", complete.HealthStatus);
        Assert.Equal(complete.HealthStatus, complete.ReadinessStatus);
        Assert.Equal(complete.HealthStatus, complete.QualificationStatus);
    }

    [Fact]
    public void Observe_RequiresDropProofForBestEffortAndCoalescibleParticipants()
    {
        var bestEffort = new TestParticipant("best-effort-queue", "BestEffortAdapter");
        var catalog = new TestCatalog(
        [
            new("best-effort-queue", "best-effort", true, "BestEffortAdapter", "observability only"),
            new("coalescible-queue", "coalescible", true, "CoalescibleAdapter", "cache acceleration")
        ]);
        var coalescible = new TestParticipant("coalescible-queue", "CoalescibleAdapter");
        var aggregator = new BoundedQueueDrainAggregator(catalog, [bestEffort, coalescible], TimeProvider.System);

        bestEffort.Set(dropProof: null);
        BoundedQueueDrainAggregateReceipt missingProof = aggregator.Observe();
        Assert.False(missingProof.Complete);
        Assert.Contains(missingProof.Participants, item => item.ErrorCode == "drop_proof_missing");

        bestEffort.Set(dropProof: new BoundedQueueDropProof("best-effort", "sample loss is allowed", "drop-counter"), terminalFailures: 1);
        coalescible.Set(dropProof: new BoundedQueueDropProof("coalescible", "latest version wins", "version monotonicity"));
        BoundedQueueDrainAggregateReceipt complete = aggregator.Observe();
        Assert.True(complete.Complete);
    }

    [Fact]
    public void Observe_FailsClosedForMissingDuplicateUnknownAndCrossRunParticipants()
    {
        var missing = new TestParticipant("expected", "ExpectedAdapter");
        var missingAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"));
        BoundedQueueDrainAggregateReceipt missingReceipt = missingAggregator.Observe();
        Assert.False(missingReceipt.Complete);
        Assert.Equal("participant_missing", missingReceipt.ErrorCode);

        var duplicateOne = new TestParticipant("expected", "ExpectedAdapter");
        var duplicateTwo = new TestParticipant("expected", "ExpectedAdapter");
        var duplicateAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            duplicateOne,
            duplicateTwo);
        BoundedQueueDrainAggregateReceipt duplicateReceipt = duplicateAggregator.Observe();
        Assert.False(duplicateReceipt.Complete);
        Assert.Equal("participant_duplicate", duplicateReceipt.ErrorCode);

        var unknown = new TestParticipant("unknown", "UnknownAdapter");
        var unknownAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            unknown);
        BoundedQueueDrainAggregateReceipt unknownReceipt = unknownAggregator.Observe();
        Assert.False(unknownReceipt.Complete);
        Assert.Equal("participant_missing", unknownReceipt.ErrorCode);
        Assert.Contains(unknownReceipt.Blockers, item => item == "unknown=unknown");

        var crossRun = new TestParticipant("expected", "ExpectedAdapter") { ForcedRunId = "old-run" };
        var crossRunAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            crossRun);
        BoundedQueueDrainAggregateReceipt crossRunReceipt = crossRunAggregator.Observe();
        Assert.False(crossRunReceipt.Complete);
        Assert.Equal("participant_cross_run", crossRunReceipt.ErrorCode);
    }

    [Fact]
    public void Observe_FailsClosedForObserverUnavailableUnderflowDigestAndGenerationDrift()
    {
        var unavailable = new TestParticipant("expected", "ExpectedAdapter") { ThrowOnObserve = true };
        var unavailableAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            unavailable);
        BoundedQueueDrainAggregateReceipt unavailableReceipt = unavailableAggregator.Observe();
        Assert.False(unavailableReceipt.Complete);
        Assert.Equal("observer_unavailable", unavailableReceipt.ErrorCode);
        Assert.Contains(unavailableReceipt.Blockers, item => item.StartsWith("observer-unavailable=", StringComparison.Ordinal));

        var underflow = new TestParticipant("expected", "ExpectedAdapter");
        underflow.Set(queued: -1);
        var underflowAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            underflow);
        BoundedQueueDrainAggregateReceipt underflowReceipt = underflowAggregator.Observe();
        Assert.Equal("count_underflow", underflowReceipt.ErrorCode);

        var digest = new TestParticipant("expected", "ExpectedAdapter") { TamperDigest = true };
        var digestAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            digest);
        BoundedQueueDrainAggregateReceipt digestReceipt = digestAggregator.Observe();
        Assert.Equal("content_digest_mismatch", digestReceipt.ErrorCode);

        var drifting = new TestParticipant("expected", "ExpectedAdapter");
        var driftingAggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            drifting);
        drifting.Set(generation: 2, sequence: 2);
        Assert.True(driftingAggregator.Observe().Complete);
        drifting.Set(generation: 2, sequence: 1);
        BoundedQueueDrainAggregateReceipt driftReceipt = driftingAggregator.Observe();
        Assert.False(driftReceipt.Complete);
        Assert.Equal("generation_drift", driftReceipt.ErrorCode);
    }

    [Fact]
    public async Task WaitAsync_ReportsCurrentBlockersForTimeoutAndCancellation()
    {
        var participant = new TestParticipant("expected", "ExpectedAdapter");
        participant.Set(queued: 1);
        var aggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            participant);

        BoundedQueueDrainAggregateReceipt timeout = await aggregator.WaitAsync(TimeSpan.FromMilliseconds(1));
        Assert.False(timeout.Complete);
        Assert.True(timeout.TimedOut);
        Assert.Equal("drain_timeout", timeout.ErrorCode);
        Assert.Contains(timeout.Blockers, item => item == "expected:queued=1");

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        BoundedQueueDrainAggregateReceipt cancelled = await aggregator.WaitAsync(TimeSpan.FromSeconds(1), cancellation.Token);
        Assert.False(cancelled.Complete);
        Assert.True(cancelled.Cancelled);
        Assert.Equal("drain_cancelled", cancelled.ErrorCode);

        BoundedQueueDrainAggregateReceipt zeroTimeout = await aggregator.WaitAsync(TimeSpan.Zero);
        Assert.False(zeroTimeout.Complete);
        Assert.True(zeroTimeout.TimedOut);
        Assert.Equal("drain_timeout", zeroTimeout.ErrorCode);
    }

    [Fact]
    public async Task WaitAsync_ConfirmsStableDigestAfterAConcurrentWrite()
    {
        var participant = new TestParticipant("expected", "ExpectedAdapter");
        var aggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            participant);
        int observations = 0;
        participant.OnObserve = () =>
        {
            if (Interlocked.Increment(ref observations) == 2)
            {
                participant.Set(queued: 1);
                participant.Set(queued: 0);
            }
        };

        BoundedQueueDrainAggregateReceipt result = await aggregator.WaitAsync(TimeSpan.FromSeconds(1));

        Assert.True(result.Complete);
        Assert.True(observations >= 4);
    }

    [Fact]
    public async Task WaitAsync_FailsClosedForWorkerCrashThenRecoversOnANewRun()
    {
        var participant = new TestParticipant("expected", "ExpectedAdapter") { ThrowOnObserve = true };
        var aggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            participant);

        BoundedQueueDrainAggregateReceipt crashed = await aggregator.WaitAsync(TimeSpan.FromMilliseconds(1));
        Assert.False(crashed.Complete);
        Assert.Equal("drain_timeout", crashed.ErrorCode);
        Assert.Contains(crashed.Blockers, item => item.StartsWith("observer-unavailable=", StringComparison.Ordinal));

        participant.ThrowOnObserve = false;
        aggregator.BeginRun("restarted-run");
        Assert.True(aggregator.Observe().Complete);
    }

    [Fact]
    public async Task EmbeddedCatalog_ExecutesTenDeterministicScenariosPerParticipant()
    {
        BoundedQueueDeliveryCatalog embedded = BoundedQueueDeliveryCatalog.Embedded;
        IReadOnlyList<BoundedChannelQueueContract> contracts = embedded.DrainParticipants;
        string[] scenarios =
        [
            "exact-drain",
            "queued-pending",
            "in-flight-pending",
            "durable-pending",
            "terminal-failure",
            "commit-postcondition-unknown",
            "drop-proof-mutation",
            "worker-crash",
            "cancel-timeout",
            "restart-generation-regression"
        ];

        int executed = 0;
        foreach (BoundedChannelQueueContract contract in contracts)
        {
            foreach (string scenario in scenarios)
            {
                (TestCatalog catalog, TestParticipant[] participants, TestParticipant target, BoundedQueueDrainAggregator aggregator) =
                    CreateEmbeddedScenario(embedded, contract.QueueId);
                BoundedQueueDropProof? proof = ValidDropProof(contract.DeliveryClass);
                BoundedQueueDrainAggregateReceipt result;
                switch (scenario)
                {
                    case "exact-drain":
                        result = aggregator.Observe();
                        Assert.True(result.Complete, $"{contract.QueueId}:{scenario}");
                        break;
                    case "queued-pending":
                        target.Set(queued: 1, dropProof: proof);
                        result = aggregator.Observe();
                        AssertBlocked(result, $"{contract.QueueId}:queued=1");
                        break;
                    case "in-flight-pending":
                        target.Set(inFlight: 1, dropProof: proof);
                        result = aggregator.Observe();
                        AssertBlocked(result, $"{contract.QueueId}:inFlight=1");
                        break;
                    case "durable-pending":
                        target.Set(durablePending: 1, dropProof: proof);
                        result = aggregator.Observe();
                        AssertBlocked(result, $"{contract.QueueId}:durablePending=1");
                        break;
                    case "terminal-failure":
                        target.Set(
                            terminalFailures: 1,
                            postcondition: BoundedQueueCommitPostcondition.Failed,
                            dropProof: proof);
                        result = aggregator.Observe();
                        Assert.False(result.Complete, $"{contract.QueueId}:{scenario}");
                        Assert.Equal("commit_postcondition_failed", result.ErrorCode);
                        break;
                    case "commit-postcondition-unknown":
                        target.Set(
                            postcondition: BoundedQueueCommitPostcondition.Unknown,
                            dropProof: proof);
                        result = aggregator.Observe();
                        Assert.False(result.Complete, $"{contract.QueueId}:{scenario}");
                        Assert.Equal("postcondition_unknown", result.ErrorCode);
                        break;
                    case "drop-proof-mutation":
                        target.Set(
                            dropProof: BoundedQueueDrainEvaluation.RequiresDropProof(contract.DeliveryClass)
                                ? null
                                : new BoundedQueueDropProof("mutated", "not a queue policy", "fixture"));
                        result = aggregator.Observe();
                        Assert.False(result.Complete, $"{contract.QueueId}:{scenario}");
                        Assert.Contains(result.ErrorCode, new[] { "drop_proof_missing", "drop_proof_invalid" });
                        break;
                    case "worker-crash":
                        target.ThrowOnObserve = true;
                        result = aggregator.Observe();
                        Assert.False(result.Complete, $"{contract.QueueId}:{scenario}");
                        Assert.Equal("observer_unavailable", result.ErrorCode);
                        break;
                    case "cancel-timeout":
                        target.Set(queued: 1, dropProof: proof);
                        result = await aggregator.WaitAsync(TimeSpan.Zero);
                        Assert.False(result.Complete, $"{contract.QueueId}:{scenario}");
                        Assert.True(result.TimedOut);
                        Assert.Equal("drain_timeout", result.ErrorCode);
                        Assert.Contains(result.Blockers, item => item == $"{contract.QueueId}:queued=1");
                        break;
                    case "restart-generation-regression":
                        Assert.True(aggregator.Observe().Complete, $"{contract.QueueId}:initial");
                        target.Set(generation: 0, sequence: 0, dropProof: proof);
                        result = aggregator.Observe();
                        Assert.False(result.Complete, $"{contract.QueueId}:{scenario}");
                        Assert.Equal("generation_drift", result.ErrorCode);
                        break;
                    default:
                        throw new InvalidOperationException($"unknown matrix scenario {scenario}");
                }

                Assert.Equal(BoundedQueueDrainDigest.AggregateSchema, result.Schema);
                Assert.Equal(embedded.Digest, result.CatalogDigest);
                Assert.Equal(result.Participants.Count, result.Participants.Select(static item => item.QueueId).Distinct(StringComparer.Ordinal).Count());
                Assert.All(result.Participants, receipt => Assert.Contains(contracts, contract => contract.QueueId == receipt.QueueId));
                if (!string.Equals(scenario, "worker-crash", StringComparison.Ordinal))
                {
                    Assert.Equal(contracts.Count, result.Participants.Count);
                }

                Assert.Equal(result.HealthStatus, result.ReadinessStatus);
                Assert.Equal(result.HealthStatus, result.QualificationStatus);
                Assert.Equal(contracts.Count, catalog.DrainParticipants.Count);
                Assert.Equal(contracts.Count, participants.Length);
                executed++;
            }
        }

        Assert.Equal(contracts.Count * scenarios.Length, executed);
        Assert.Equal(scenarios.Length, scenarios.Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void Observe_IsolatesQueueFailureFromPeerReceiptIdentityAndHealth()
    {
        BoundedQueueDeliveryCatalog embedded = BoundedQueueDeliveryCatalog.Embedded;
        IReadOnlyList<BoundedChannelQueueContract> contracts = embedded.DrainParticipants;
        (TestCatalog _, TestParticipant[] participants, TestParticipant target, BoundedQueueDrainAggregator aggregator) =
            CreateEmbeddedScenario(embedded, contracts[0].QueueId);
        TestParticipant peer = participants.First(item => !string.Equals(item.QueueId, target.QueueId, StringComparison.Ordinal));

        BoundedQueueDrainAggregateReceipt baseline = aggregator.Observe();
        BoundedQueueParticipantReceipt baselinePeer = baseline.Participants.Single(item => item.QueueId == peer.QueueId);
        target.Set(queued: 1, dropProof: ValidDropProof(target.DeliveryClass));
        BoundedQueueDrainAggregateReceipt blocked = aggregator.Observe();
        BoundedQueueParticipantReceipt blockedPeer = blocked.Participants.Single(item => item.QueueId == peer.QueueId);

        Assert.False(blocked.Complete);
        Assert.NotEqual("ok", blocked.HealthStatus);
        Assert.Equal(baselinePeer.RunId, blockedPeer.RunId);
        Assert.Equal(baselinePeer.Generation, blockedPeer.Generation);
        Assert.Equal(baselinePeer.Sequence, blockedPeer.Sequence);
        Assert.Equal(baselinePeer.ContentDigest, blockedPeer.ContentDigest);
        Assert.Equal(0, blockedPeer.Queued);
        Assert.Equal(0, blockedPeer.InFlight);
        Assert.Equal(0, blockedPeer.DurablePending);

        target.Set(queued: 0, dropProof: ValidDropProof(target.DeliveryClass));
        BoundedQueueDrainAggregateReceipt recovered = aggregator.Observe();
        Assert.True(recovered.Complete);
        Assert.Equal("ok", recovered.HealthStatus);
    }

    [Fact]
    public async Task ReleaseDrainParticipant_UsesTheAggregateForQualification()
    {
        var participant = new TestParticipant("expected", "ExpectedAdapter");
        BoundedQueueDrainAggregator aggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            participant);
        participant.Set(queued: 1);
        var releaseParticipant = new BoundedQueueDrainReleaseParticipant(aggregator);

        ReleaseDrainParticipantSnapshot pending = releaseParticipant.Snapshot();
        Assert.Equal(1, pending.PendingCount);
        Assert.NotNull(pending.ErrorCode);
        Assert.Contains("aggregate=sha256:", pending.ReplaySource, StringComparison.Ordinal);

        participant.Set(queued: 0);
        await releaseParticipant.DrainAsync(CancellationToken.None);

        ReleaseDrainParticipantSnapshot drained = releaseParticipant.Snapshot();
        Assert.Equal(0, drained.PendingCount);
        Assert.Equal("drained", drained.Status);
        Assert.Null(drained.ErrorCode);
        Assert.Contains("catalog=sha256:test-catalog;aggregate=sha256:", drained.ReplaySource, StringComparison.Ordinal);
    }

    [Fact]
    public void BeginRun_ChangesCurrentRunAndRejectsReuse()
    {
        var participant = new TestParticipant("expected", "ExpectedAdapter");
        var aggregator = CreateAggregator(
            new("expected", "required", true, "ExpectedAdapter", "required"),
            participant);
        aggregator.BeginRun("run-2");
        Assert.Equal("run-2", aggregator.CurrentRunId);
        Assert.Equal("run-2", Assert.Single(aggregator.Observe().Participants).RunId);
        Assert.Throws<ArgumentException>(() => aggregator.BeginRun("run-2"));
    }

    private static BoundedQueueDrainAggregator CreateAggregator(
        BoundedChannelQueueContract contract,
        params IBoundedQueueDrainParticipant[] participants)
        => new(new TestCatalog([contract]), participants, TimeProvider.System);

    private static (TestCatalog Catalog, TestParticipant[] Participants, TestParticipant Target, BoundedQueueDrainAggregator Aggregator) CreateEmbeddedScenario(
        BoundedQueueDeliveryCatalog embedded,
        string targetQueueId)
    {
        BoundedChannelQueueContract[] contracts = embedded.DrainParticipants.ToArray();
        var catalog = new TestCatalog(contracts, embedded.Digest);
        TestParticipant[] participants = contracts
            .Select(contract => new TestParticipant(
                contract.QueueId,
                contract.ParticipantAdapterToken!,
                contract.DeliveryClass))
            .ToArray();
        foreach ((TestParticipant participant, BoundedChannelQueueContract contract) in participants.Zip(contracts))
        {
            participant.Set(dropProof: ValidDropProof(contract.DeliveryClass));
        }

        TestParticipant target = participants.Single(item => string.Equals(item.QueueId, targetQueueId, StringComparison.Ordinal));
        return (catalog, participants, target, new BoundedQueueDrainAggregator(catalog, participants, TimeProvider.System));
    }

    private static BoundedQueueDropProof? ValidDropProof(string deliveryClass)
        => deliveryClass switch
        {
            "best-effort" => new BoundedQueueDropProof("best-effort", "loss is observable and allowed", "drop-counter"),
            "coalescible" => new BoundedQueueDropProof("coalescible", "latest version wins", "monotonic-version"),
            _ => null
        };

    private static void AssertBlocked(BoundedQueueDrainAggregateReceipt receipt, string blocker)
    {
        Assert.False(receipt.Complete);
        Assert.Contains(receipt.Blockers, item => item.EndsWith(blocker, StringComparison.Ordinal));
    }

    private sealed class TestCatalog(
        IReadOnlyList<BoundedChannelQueueContract> queues,
        string digest = "sha256:test-catalog") : IBoundedQueueDrainCatalog
    {
        public string Digest => digest;

        public IReadOnlyList<BoundedChannelQueueContract> Queues => queues;

        public IReadOnlyList<BoundedChannelQueueContract> DrainParticipants => queues.Where(static item => item.DrainParticipant).ToArray();
    }

    private sealed class TestParticipant(
        string queueId,
        string adapterToken,
        string? deliveryClass = null) : IBoundedQueueDrainParticipant
    {
        private long _generation;
        private long _sequence;
        private long _queued;
        private long _inFlight;
        private long _durablePending;
        private long _terminalFailures;
        private BoundedQueueCommitPostcondition _postcondition = BoundedQueueCommitPostcondition.Success;
        private BoundedQueueDropProof? _dropProof;
        private readonly string _deliveryClass = deliveryClass
            ?? (queueId.Contains("best-effort", StringComparison.Ordinal) ? "best-effort"
                : queueId.Contains("coalescible", StringComparison.Ordinal) ? "coalescible"
                : "required");

        public string QueueId => queueId;

        public string AdapterToken => adapterToken;

        public string? ForcedRunId { get; set; }

        public bool ThrowOnObserve { get; set; }

        public bool TamperDigest { get; set; }

        public Action? OnObserve { get; set; }

        public void Set(
            long? generation = null,
            long? sequence = null,
            long? queued = null,
            long? inFlight = null,
            long? durablePending = null,
            long? terminalFailures = null,
            BoundedQueueCommitPostcondition? postcondition = null,
            BoundedQueueDropProof? dropProof = null)
        {
            if (!sequence.HasValue)
            {
                _sequence++;
            }

            if (generation.HasValue) _generation = generation.Value;
            if (sequence.HasValue) _sequence = sequence.Value;
            if (queued.HasValue) _queued = queued.Value;
            if (inFlight.HasValue) _inFlight = inFlight.Value;
            if (durablePending.HasValue) _durablePending = durablePending.Value;
            if (terminalFailures.HasValue) _terminalFailures = terminalFailures.Value;
            if (postcondition.HasValue) _postcondition = postcondition.Value;
            _dropProof = dropProof;
        }

        public BoundedQueueParticipantReceipt Observe(string runId)
        {
            OnObserve?.Invoke();
            if (ThrowOnObserve)
            {
                throw new InvalidOperationException("observer unavailable");
            }

            BoundedQueueParticipantReceipt receipt = BoundedQueueParticipantReceipt.Create(
                queueId,
                DeliveryClass,
                ForcedRunId ?? runId,
                _generation,
                _sequence,
                _queued,
                _inFlight,
                _durablePending,
                _terminalFailures,
                _postcondition,
                _dropProof,
                [],
                s_observedAt);
            return TamperDigest ? receipt with { ContentDigest = "sha256:tampered" } : receipt;
        }

        public string DeliveryClass => _deliveryClass;
    }
}
