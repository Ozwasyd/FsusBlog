namespace FsusBlog.Server.Infrastructure.Operations;

public sealed class BoundedQueueDrainAggregator(
    IBoundedQueueDrainCatalog catalog,
    IEnumerable<IBoundedQueueDrainParticipant> participants,
    TimeProvider timeProvider)
{
    private readonly IBoundedQueueDrainParticipant?[] _participants = (participants ?? throw new ArgumentNullException(nameof(participants)))
        .OrderBy(static participant => participant?.QueueId ?? string.Empty, StringComparer.Ordinal)
        .ToArray();
    private readonly object _gate = new();
    private string _runId = Guid.NewGuid().ToString("N");
    private readonly Dictionary<string, (long Generation, long Sequence, string Digest)> _lastSeen = new(StringComparer.Ordinal);

    public string CurrentRunId
    {
        get
        {
            lock (_gate)
            {
                return _runId;
            }
        }
    }

    public void BeginRun(string? runId = null)
    {
        lock (_gate)
        {
            string nextRunId = string.IsNullOrWhiteSpace(runId) ? Guid.NewGuid().ToString("N") : runId;
            if (string.Equals(nextRunId, _runId, StringComparison.Ordinal))
            {
                throw new ArgumentException("drain run id must advance for every run", nameof(runId));
            }

            _runId = nextRunId;
            _lastSeen.Clear();
        }
    }

    public BoundedQueueDrainAggregateReceipt Observe()
    {
        string runId;
        lock (_gate)
        {
            runId = _runId;
        }

        BoundedQueueDrainAggregateReceipt first = ObserveRun(runId, timedOut: false, cancelled: false);
        if (!first.Complete)
        {
            return first;
        }

        BoundedQueueDrainAggregateReceipt confirmation = ObserveRun(runId, timedOut: false, cancelled: false);
        if (confirmation.Complete
            && string.Equals(confirmation.ContentDigest, first.ContentDigest, StringComparison.Ordinal))
        {
            return confirmation;
        }

        if (confirmation.ErrorCode is not null || !confirmation.Complete)
        {
            return confirmation;
        }

        return confirmation with
        {
            Complete = false,
            HealthStatus = "failed",
            ReadinessStatus = "failed",
            QualificationStatus = "failed",
            ErrorCode = "aggregate_snapshot_changed",
            Blockers = confirmation.Blockers
                .Append("aggregate-snapshot-changed=true")
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static item => item, StringComparer.Ordinal)
                .ToArray()
        };
    }

    public async Task<BoundedQueueDrainAggregateReceipt> WaitAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout < TimeSpan.Zero)
        {
            timeout = TimeSpan.Zero;
        }

        linked.CancelAfter(timeout);
        if (cancellationToken.IsCancellationRequested)
        {
            return ObserveRun(CurrentRunId, timedOut: false, cancelled: true);
        }

        if (timeout == TimeSpan.Zero)
        {
            return ObserveRun(CurrentRunId, timedOut: true, cancelled: false);
        }

        BoundedQueueDrainAggregateReceipt latest = Observe();

        while (true)
        {
            if (latest.Complete)
            {
                BoundedQueueDrainAggregateReceipt confirmation = Observe();
                if (confirmation.Complete
                    && string.Equals(confirmation.ContentDigest, latest.ContentDigest, StringComparison.Ordinal))
                {
                    if (cancellationToken.IsCancellationRequested || linked.IsCancellationRequested)
                    {
                        return ObserveRun(CurrentRunId, timedOut: !cancellationToken.IsCancellationRequested, cancelled: cancellationToken.IsCancellationRequested);
                    }

                    return confirmation;
                }

                latest = confirmation;
            }

            try
            {
                await Task.Delay(TimeSpan.FromMilliseconds(50), timeProvider, linked.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                bool cancelled = cancellationToken.IsCancellationRequested;
                BoundedQueueDrainAggregateReceipt blocked = ObserveRun(
                    CurrentRunId,
                    timedOut: !cancelled,
                    cancelled: cancelled);
                return blocked with
                {
                    Complete = false,
                    ErrorCode = cancelled ? "drain_cancelled" : "drain_timeout"
                };
            }

            latest = Observe();
        }
    }

    private BoundedQueueDrainAggregateReceipt ObserveRun(string runId, bool timedOut, bool cancelled)
    {
        var observed = new List<BoundedQueueParticipantReceipt>(_participants.Length);
        var observations = new List<(IBoundedQueueDrainParticipant Adapter, BoundedQueueParticipantReceipt Receipt)>(_participants.Length);
        string? error = null;
        var blockers = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (IBoundedQueueDrainParticipant? participant in _participants)
        {
            if (participant is null)
            {
                error ??= "observer_unavailable";
                blockers.Add("observer-unavailable=<null>");
                continue;
            }

            BoundedQueueParticipantReceipt receipt;
            try
            {
                receipt = participant.Observe(runId);
            }
            catch (Exception exception)
            {
                error ??= "observer_unavailable";
                blockers.Add($"observer-unavailable={participant.QueueId}:{exception.GetType().Name}");
                continue;
            }

            if (receipt is null)
            {
                error ??= "observer_unavailable";
                blockers.Add($"observer-unavailable={participant.QueueId}:null-receipt");
                continue;
            }

            if (string.IsNullOrWhiteSpace(receipt.QueueId))
            {
                error ??= "participant_identity_invalid";
                blockers.Add($"identity-invalid={participant.QueueId}");
                continue;
            }

            if (!string.Equals(receipt.QueueId, participant.QueueId, StringComparison.Ordinal))
            {
                error ??= "participant_queue_mismatch";
                blockers.Add($"queue-mismatch adapter={participant.QueueId} receipt={receipt.QueueId}");
            }

            if (!seen.Add(receipt.QueueId))
            {
                error ??= "participant_duplicate";
                blockers.Add($"duplicate={receipt.QueueId}");
            }

            if (!string.Equals(receipt.RunId, runId, StringComparison.Ordinal))
            {
                error ??= "participant_cross_run";
                blockers.Add($"cross-run={receipt.QueueId}");
            }

            if (!BoundedQueueDrainEvaluation.IsKnownDeliveryClass(receipt.DeliveryClass))
            {
                error ??= "delivery_class_unknown";
                blockers.Add($"delivery-class-unknown={receipt.QueueId}");
            }

            lock (_gate)
            {
                if (!string.Equals(_runId, runId, StringComparison.Ordinal))
                {
                    error ??= "current_run_changed";
                    blockers.Add($"run-changed={runId}->{_runId}");
                }
                else if (_lastSeen.TryGetValue(receipt.QueueId, out (long Generation, long Sequence, string Digest) previous))
                {
                    bool regressed = receipt.Generation < previous.Generation
                        || (receipt.Generation == previous.Generation && receipt.Sequence < previous.Sequence);
                    bool collided = receipt.Generation == previous.Generation
                        && receipt.Sequence == previous.Sequence
                        && !string.Equals(receipt.ContentDigest, previous.Digest, StringComparison.Ordinal);
                    if (regressed || collided)
                    {
                        error ??= "generation_drift";
                        blockers.Add(collided
                            ? $"sequence-collision={receipt.QueueId}"
                            : $"generation-drift={receipt.QueueId}");
                    }

                    _lastSeen[receipt.QueueId] = (receipt.Generation, receipt.Sequence, receipt.ContentDigest);
                }
                else
                {
                    _lastSeen[receipt.QueueId] = (receipt.Generation, receipt.Sequence, receipt.ContentDigest);
                }
            }

            if (receipt.ErrorCode is not null)
            {
                error ??= receipt.ErrorCode;
            }

            if (string.IsNullOrWhiteSpace(receipt.DeliveryClass)
                || string.IsNullOrWhiteSpace(receipt.RunId))
            {
                error ??= "participant_identity_invalid";
                blockers.Add($"identity-invalid={receipt.QueueId}:delivery-or-run");
            }

            if (receipt.Generation < 0 || receipt.Sequence < 0)
            {
                error ??= "generation_underflow";
                blockers.Add($"underflow={receipt.QueueId}:generation={receipt.Generation};sequence={receipt.Sequence}");
            }

            if (receipt.Queued < 0
                || receipt.InFlight < 0
                || receipt.DurablePending < 0
                || receipt.TerminalFailures < 0)
            {
                error ??= "count_underflow";
                blockers.Add($"underflow={receipt.QueueId}:queued={receipt.Queued};inFlight={receipt.InFlight};durablePending={receipt.DurablePending};terminalFailures={receipt.TerminalFailures}");
            }

            if (receipt.CommitPostcondition is not (BoundedQueueCommitPostcondition.Success
                or BoundedQueueCommitPostcondition.Failed
                or BoundedQueueCommitPostcondition.Unknown))
            {
                error ??= "postcondition_unknown";
                blockers.Add($"postcondition-unknown={receipt.QueueId}");
            }
            else if (receipt.CommitPostcondition == BoundedQueueCommitPostcondition.Unknown)
            {
                error ??= "postcondition_unknown";
                blockers.Add($"postcondition-unknown={receipt.QueueId}");
            }
            else if (receipt.CommitPostcondition == BoundedQueueCommitPostcondition.Failed)
            {
                error ??= "commit_postcondition_failed";
                blockers.Add($"postcondition-failed={receipt.QueueId}");
            }

            if (BoundedQueueDrainEvaluation.RequiresDropProof(receipt.DeliveryClass)
                && receipt.DropProof is null)
            {
                error ??= "drop_proof_missing";
                blockers.Add($"drop-proof-missing={receipt.QueueId}");
            }
            else if (receipt.DropProof is not null
                && !BoundedQueueDrainEvaluation.IsValidDropProof(receipt.DeliveryClass, receipt.DropProof))
            {
                error ??= "drop_proof_invalid";
                blockers.Add($"drop-proof-invalid={receipt.QueueId}");
            }

            string expectedDigest = BoundedQueueDrainDigest.Receipt(
                receipt.QueueId,
                receipt.DeliveryClass,
                receipt.RunId,
                receipt.Generation,
                receipt.Sequence,
                receipt.Queued,
                receipt.InFlight,
                receipt.DurablePending,
                receipt.TerminalFailures,
                receipt.CommitPostcondition,
                receipt.DropProof);
            if (!string.Equals(receipt.ContentDigest, expectedDigest, StringComparison.Ordinal))
            {
                error ??= "content_digest_mismatch";
                blockers.Add($"content-digest-mismatch={receipt.QueueId}");
            }

            observed.Add(receipt);
            observations.Add((participant, receipt));
            if (receipt.Blockers is null)
            {
                error ??= "participant_identity_invalid";
                blockers.Add($"blockers-missing={receipt.QueueId}");
            }
            else
            {
                blockers.AddRange(receipt.Blockers.Select(item => $"{receipt.QueueId}:{item}"));
            }
        }

        IReadOnlyList<BoundedChannelQueueContract> expected = catalog.DrainParticipants ?? [];
        if (expected.Count == 0)
        {
            error ??= "participant_catalog_empty";
            blockers.Add("catalog=empty");
        }
        var expectedIds = new HashSet<string>(StringComparer.Ordinal);
        var expectedAdapterTokens = new HashSet<string>(StringComparer.Ordinal);
        foreach (BoundedChannelQueueContract contract in expected)
        {
            if (!BoundedQueueDrainEvaluation.IsKnownDeliveryClass(contract.DeliveryClass))
            {
                error ??= "delivery_class_unknown";
                blockers.Add($"delivery-class-unknown={contract.QueueId}");
            }

            if (!expectedIds.Add(contract.QueueId))
            {
                error ??= "catalog_duplicate";
                blockers.Add($"catalog-duplicate={contract.QueueId}");
            }

            if (!string.IsNullOrWhiteSpace(contract.ParticipantAdapterToken)
                && !expectedAdapterTokens.Add(contract.ParticipantAdapterToken))
            {
                error ??= "catalog_duplicate";
                blockers.Add($"catalog-adapter-duplicate={contract.ParticipantAdapterToken}");
            }
        }
        var observedIds = new HashSet<string>(observed.Select(static item => item.QueueId), StringComparer.Ordinal);
        foreach (BoundedChannelQueueContract contract in expected)
        {
            if (!observedIds.Contains(contract.QueueId))
            {
                error ??= "participant_missing";
                blockers.Add($"missing={contract.QueueId}");
            }
        }

        foreach ((IBoundedQueueDrainParticipant adapter, BoundedQueueParticipantReceipt receipt) in observations)
        {
            BoundedChannelQueueContract? contract = expected.FirstOrDefault(
                item => string.Equals(item.QueueId, receipt.QueueId, StringComparison.Ordinal));
            if (contract is null)
            {
                error ??= "participant_unknown";
                blockers.Add($"unknown={receipt.QueueId}");
                continue;
            }

            if (!string.Equals(receipt.DeliveryClass, contract.DeliveryClass, StringComparison.Ordinal))
            {
                error ??= "delivery_class_mismatch";
                blockers.Add($"delivery-class-mismatch={receipt.QueueId}");
            }

            if (!string.Equals(receipt.RunId, runId, StringComparison.Ordinal))
            {
                error ??= "participant_cross_run";
                blockers.Add($"cross-run={receipt.QueueId}");
            }

            if (!string.Equals(adapter.AdapterToken, contract.ParticipantAdapterToken, StringComparison.Ordinal))
            {
                error ??= "participant_adapter_mismatch";
                blockers.Add($"adapter-mismatch={receipt.QueueId}");
            }
        }

        if (timedOut)
        {
            error ??= "drain_timeout";
        }

        if (cancelled)
        {
            error ??= "drain_cancelled";
        }

        lock (_gate)
        {
            if (!string.Equals(_runId, runId, StringComparison.Ordinal))
            {
                error ??= "current_run_changed";
                blockers.Add($"run-changed={runId}->{_runId}");
            }
        }

        bool complete = error is null
            && !timedOut
            && !cancelled
            && expected.Count == observed.Count
            && observed.All(BoundedQueueDrainEvaluation.ParticipantComplete);
        (string health, string readiness, string qualification) = BoundedQueueDrainEvaluation.Judge(complete, error, observed);
        string contentDigest = BoundedQueueDrainDigest.Aggregate(runId, catalog.Digest, observed);
        return new BoundedQueueDrainAggregateReceipt(
            BoundedQueueDrainDigest.AggregateSchema,
            runId,
            catalog.Digest,
            contentDigest,
            complete,
            timedOut,
            cancelled,
            blockers.Distinct(StringComparer.Ordinal).OrderBy(static item => item, StringComparer.Ordinal).ToArray(),
            observed
                .OrderBy(static item => item.QueueId, StringComparer.Ordinal)
                .ToArray(),
            health,
            readiness,
            qualification,
            error,
            timeProvider.GetUtcNow());
    }
}
