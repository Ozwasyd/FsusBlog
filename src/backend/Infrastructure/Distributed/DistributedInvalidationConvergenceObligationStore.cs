using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class DistributedInvalidationConvergenceObligationStore(
    ISqlSugarClient db,
    TimeProvider timeProvider,
    DistributedInvalidationConvergenceRuntimeState runtimeState)
    : IDistributedInvalidationObligationStore, IDistributedInvalidationDeliveryLedger
{
    private const string PendingState = "pending";
    private const string PartiallyAckedState = "partially-acked";
    private const string CompleteState = "complete";
    private const string TerminalFailedState = "terminal-failed";
    private const string InboxPendingState = "pending";
    private const string InboxApplyingState = "applying";
    private const string InboxAppliedState = "applied";
    private const string InboxRetryableFailedState = "retryable-failed";
    private const string InboxTerminalFailedState = "terminal-failed";
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web);

    public async Task PrepareOutboxAsync(
        DistributedInvalidationEvent invalidation,
        DistributedInvalidationTopologyManifest topology,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        invalidation.Validate();
        if (!topology.SubscriberNodeIds.Contains(invalidation.SourceNodeId, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_outbox_source_not_in_topology");
        }

        string payload = JsonSerializer.Serialize(invalidation, s_json);
        string payloadDigest = Digest(payload);
        string[] requiredNodes = topology.SubscriberNodeIds.Order(StringComparer.Ordinal).ToArray();
        string[] ackedNodes = [invalidation.SourceNodeId];
        string requiredJson = JsonSerializer.Serialize(requiredNodes, s_json);
        string ackedJson = JsonSerializer.Serialize(ackedNodes, s_json);
        string identity = ComputeSourceMutationIdentity(invalidation);
        string obligationId = Digest($"{invalidation.RuntimeScope}:{invalidation.EventId}");
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        string initialState = requiredNodes.Length == 1 ? CompleteState : PartiallyAckedState;

        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO distributed_invalidation_convergence_obligation (
                obligation_id,
                event_id,
                kind,
                source_node_id,
                runtime_scope,
                source_mutation_identity,
                required_topology_digest,
                publish_status,
                transport_status,
                state,
                attempt_count,
                last_failure_kind,
                created_at,
                payload_digest,
                payload_json,
                required_node_ids,
                acked_node_ids,
                last_attempt_at)
            VALUES (
                @ObligationId,
                @EventId,
                @Kind,
                @SourceNodeId,
                @RuntimeScope,
                @Identity,
                @TopologyDigest,
                'Degraded',
                NULL,
                @State,
                0,
                NULL,
                @CreatedAt,
                @PayloadDigest,
                @PayloadJson,
                @RequiredNodeIds,
                @AckedNodeIds,
                NULL)
            ON CONFLICT (runtime_scope, event_id) DO NOTHING;
            """,
            new SugarParameter("@ObligationId", obligationId),
            new SugarParameter("@EventId", invalidation.EventId),
            new SugarParameter("@Kind", invalidation.Kind),
            new SugarParameter("@SourceNodeId", invalidation.SourceNodeId),
            new SugarParameter("@RuntimeScope", invalidation.RuntimeScope),
            new SugarParameter("@Identity", identity),
            new SugarParameter("@TopologyDigest", topology.Digest),
            new SugarParameter("@State", initialState),
            new SugarParameter("@CreatedAt", now),
            new SugarParameter("@PayloadDigest", payloadDigest),
            new SugarParameter("@PayloadJson", payload),
            new SugarParameter("@RequiredNodeIds", requiredJson),
            new SugarParameter("@AckedNodeIds", ackedJson)).ConfigureAwait(false);

        DistributedInvalidationConvergenceObligationEntity row = await FindOutboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            cancellationToken).ConfigureAwait(false);
        if (!string.Equals(row.PayloadDigest, payloadDigest, StringComparison.Ordinal)
            || !string.Equals(row.RequiredTopologyDigest, topology.Digest, StringComparison.Ordinal)
            || !string.Equals(row.SourceMutationIdentity, identity, StringComparison.Ordinal)
            || !string.Equals(row.Kind, invalidation.Kind, StringComparison.Ordinal)
            || !string.Equals(row.SourceNodeId, invalidation.SourceNodeId, StringComparison.Ordinal)
            || !NodeSetEquals(ParseNodes(row.RequiredNodeIds), requiredNodes))
        {
            throw new InvalidOperationException("distributed_invalidation_outbox_contract_mismatch");
        }
        runtimeState.Record(await SnapshotAsync(cancellationToken).ConfigureAwait(false));
    }

    public async Task RecordPublishAttemptAsync(
        DistributedInvalidationPublishResult result,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DistributedInvalidationEvent invalidation = ValidatePublishResult(result);
        DistributedInvalidationConvergenceObligationEntity row = await FindOutboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            cancellationToken).ConfigureAwait(false);
        string payloadDigest = Digest(JsonSerializer.Serialize(invalidation, s_json));
        string topologyDigest = result.TransportReceipt!.TopologyDigest
            ?? throw new InvalidOperationException("distributed_invalidation_outbox_topology_required");
        if (!string.Equals(row.PayloadDigest, payloadDigest, StringComparison.Ordinal)
            || !string.Equals(row.RequiredTopologyDigest, topologyDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_outbox_publish_identity_mismatch");
        }

        DateTime observedAt = result.TransportReceipt.ObservedAt.UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE distributed_invalidation_convergence_obligation
            SET publish_status = @PublishStatus,
                transport_status = @TransportStatus,
                attempt_count = attempt_count + 1,
                last_attempt_at = @ObservedAt,
                last_failure_kind = @Failure
            WHERE id = @Id
              AND (last_attempt_at IS NULL OR last_attempt_at <> @ObservedAt);
            """,
            new SugarParameter("@PublishStatus", result.Status.ToString()),
            new SugarParameter("@TransportStatus", result.TransportReceipt.TransportStatus.ToString()),
            new SugarParameter("@ObservedAt", observedAt),
            new SugarParameter("@Failure", result.Detail ?? (object)DBNull.Value),
            new SugarParameter("@Id", row.Id)).ConfigureAwait(false);
        runtimeState.Record(await SnapshotAsync(cancellationToken).ConfigureAwait(false));
    }

    public async Task<DistributedInvalidationConvergenceObligation> UpsertAsync(
        DistributedInvalidationPublishResult result,
        CancellationToken cancellationToken = default)
    {
        DistributedInvalidationEvent invalidation = ValidatePublishResult(result);
        await RecordPublishAttemptAsync(result, cancellationToken).ConfigureAwait(false);
        return ToContract(await FindOutboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            cancellationToken).ConfigureAwait(false));
    }

    public async Task<DistributedInvalidationInboxReceipt> ReceiveAsync(
        DistributedInvalidationEvent invalidation,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        invalidation.Validate();
        ValidateNodeId(targetNodeId);
        string payloadDigest = Digest(JsonSerializer.Serialize(invalidation, s_json));
        DistributedInvalidationConvergenceObligationEntity outbox = await FindOutboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            cancellationToken).ConfigureAwait(false);
        if (!ParseNodes(outbox.RequiredNodeIds).Contains(targetNodeId, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_inbox_target_not_required");
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO distributed_invalidation_inbox (
                event_id,
                runtime_scope,
                target_node_id,
                payload_digest,
                received_at,
                apply_state,
                apply_attempt,
                last_failure_kind,
                applied_generation)
            VALUES (
                @EventId,
                @RuntimeScope,
                @TargetNodeId,
                @PayloadDigest,
                @ReceivedAt,
                'pending',
                0,
                NULL,
                NULL)
            ON CONFLICT (runtime_scope, event_id, target_node_id) DO NOTHING;
            """,
            new SugarParameter("@EventId", invalidation.EventId),
            new SugarParameter("@RuntimeScope", invalidation.RuntimeScope),
            new SugarParameter("@TargetNodeId", targetNodeId),
            new SugarParameter("@PayloadDigest", payloadDigest),
            new SugarParameter("@ReceivedAt", now)).ConfigureAwait(false);

        DistributedInvalidationInboxEntity row = await FindInboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            targetNodeId,
            cancellationToken).ConfigureAwait(false);
        bool mismatch = !string.Equals(row.PayloadDigest, payloadDigest, StringComparison.Ordinal)
            || !string.Equals(outbox.PayloadDigest, payloadDigest, StringComparison.Ordinal);
        if (mismatch)
        {
            var transaction = await db.Ado.UseTranAsync(async () =>
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE distributed_invalidation_inbox
                    SET apply_state = 'terminal-failed',
                        apply_attempt = apply_attempt + 1,
                        last_failure_kind = 'payload-digest-mismatch'
                    WHERE id = @InboxId;
                    """,
                    new SugarParameter("@InboxId", row.Id)).ConfigureAwait(false);
                await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE distributed_invalidation_convergence_obligation
                    SET state = 'terminal-failed',
                        last_failure_kind = 'payload-digest-mismatch'
                    WHERE id = @OutboxId;
                    """,
                    new SugarParameter("@OutboxId", outbox.Id)).ConfigureAwait(false);
            }).ConfigureAwait(false);
            EnsureTransaction(transaction.IsSuccess, transaction.ErrorException);
            runtimeState.Record(await SnapshotAsync(cancellationToken).ConfigureAwait(false));
            return new DistributedInvalidationInboxReceipt(false, true, true, DistributedInvalidationInboxApplyState.TerminalFailed);
        }

        DistributedInvalidationInboxApplyState state = ParseInboxState(row.ApplyState);
        return new DistributedInvalidationInboxReceipt(
            state == DistributedInvalidationInboxApplyState.Applied,
            false,
            state == DistributedInvalidationInboxApplyState.TerminalFailed,
            state);
    }

    public async Task<bool> TryBeginApplyAsync(
        DistributedInvalidationEvent invalidation,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        int changed = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE distributed_invalidation_inbox
            SET apply_state = 'applying',
                apply_attempt = apply_attempt + 1,
                last_failure_kind = NULL
            WHERE runtime_scope = @RuntimeScope
              AND event_id = @EventId
              AND target_node_id = @TargetNodeId
              AND payload_digest = @PayloadDigest
              AND apply_state IN ('pending', 'retryable-failed');
            """,
            new SugarParameter("@RuntimeScope", invalidation.RuntimeScope),
            new SugarParameter("@EventId", invalidation.EventId),
            new SugarParameter("@TargetNodeId", targetNodeId),
            new SugarParameter("@PayloadDigest", Digest(JsonSerializer.Serialize(invalidation, s_json)))).ConfigureAwait(false);
        return changed == 1;
    }

    public async Task RecordApplyAsync(
        DistributedInvalidationEvent invalidation,
        string targetNodeId,
        DistributedInvalidationInboxApplyState state,
        string? failureKind,
        long? generation,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (state is DistributedInvalidationInboxApplyState.Pending
            or DistributedInvalidationInboxApplyState.Applying)
        {
            throw new InvalidOperationException("distributed_invalidation_inbox_terminal_transition_required");
        }
        if (state == DistributedInvalidationInboxApplyState.Applied && generation is not > 0)
        {
            throw new InvalidOperationException("distributed_invalidation_inbox_applied_generation_required");
        }
        if (state != DistributedInvalidationInboxApplyState.Applied && string.IsNullOrWhiteSpace(failureKind))
        {
            throw new InvalidOperationException("distributed_invalidation_inbox_failure_kind_required");
        }

        DistributedInvalidationInboxEntity inbox = await FindInboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            targetNodeId,
            cancellationToken).ConfigureAwait(false);
        DistributedInvalidationConvergenceObligationEntity outbox = await FindOutboxAsync(
            invalidation.RuntimeScope,
            invalidation.EventId,
            cancellationToken).ConfigureAwait(false);
        if (!string.Equals(inbox.PayloadDigest, outbox.PayloadDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_inbox_outbox_digest_mismatch");
        }

        string stateValue = FormatInboxState(state);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            int changed = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE distributed_invalidation_inbox
                SET apply_state = @State,
                    last_failure_kind = @Failure,
                    applied_generation = CAST(@Generation AS bigint)
                WHERE id = @Id
                  AND apply_state = 'applying';
                """,
                new SugarParameter("@State", stateValue),
                new SugarParameter("@Failure", failureKind ?? (object)DBNull.Value),
                new SugarParameter("@Generation", generation ?? (object)DBNull.Value),
                new SugarParameter("@Id", inbox.Id)).ConfigureAwait(false);
            if (changed != 1)
            {
                throw new InvalidOperationException("distributed_invalidation_inbox_apply_claim_lost");
            }

            if (state == DistributedInvalidationInboxApplyState.TerminalFailed)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE distributed_invalidation_convergence_obligation
                    SET state = 'terminal-failed',
                        last_failure_kind = @Failure
                    WHERE id = @Id;
                    """,
                    new SugarParameter("@Failure", failureKind!),
                    new SugarParameter("@Id", outbox.Id)).ConfigureAwait(false);
                return;
            }
            if (state != DistributedInvalidationInboxApplyState.Applied)
            {
                return;
            }

            int acked = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE distributed_invalidation_convergence_obligation
                SET acked_node_ids = (
                        SELECT jsonb_agg(value ORDER BY value)::text
                        FROM (
                            SELECT DISTINCT jsonb_array_elements_text(
                                COALESCE(acked_node_ids, '[]')::jsonb || to_jsonb(@TargetNodeId::text)) AS value
                        ) ack_set),
                    state = CASE
                        WHEN NOT EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements_text(required_node_ids::jsonb) required(value)
                            WHERE required.value NOT IN (
                                SELECT jsonb_array_elements_text(
                                    COALESCE(acked_node_ids, '[]')::jsonb || to_jsonb(@TargetNodeId::text)))
                        )
                        THEN 'complete'
                        ELSE 'partially-acked'
                    END,
                    last_failure_kind = NULL
                WHERE id = @Id
                  AND state IN ('pending', 'partially-acked');
                """,
                new SugarParameter("@TargetNodeId", targetNodeId),
                new SugarParameter("@Id", outbox.Id)).ConfigureAwait(false);
            if (acked != 1)
            {
                throw new InvalidOperationException("distributed_invalidation_outbox_ack_rejected");
            }
        }).ConfigureAwait(false);
        EnsureTransaction(transaction.IsSuccess, transaction.ErrorException);
        runtimeState.Record(await SnapshotAsync(cancellationToken).ConfigureAwait(false));
    }

    public async Task RecoverInterruptedAsync(
        string runtimeScope,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE distributed_invalidation_inbox
            SET apply_state = 'retryable-failed',
                last_failure_kind = 'process-interrupted'
            WHERE runtime_scope = @RuntimeScope
              AND target_node_id = @TargetNodeId
              AND apply_state = 'applying';
            """,
            new SugarParameter("@RuntimeScope", runtimeScope),
            new SugarParameter("@TargetNodeId", targetNodeId)).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<DistributedInvalidationEvent>> ReadPendingForNodeAsync(
        string runtimeScope,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<DistributedInvalidationConvergenceObligationEntity> rows = await db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(row => row.RuntimeScope == runtimeScope
                && (row.State == PendingState || row.State == PartiallyAckedState))
            .OrderBy(row => row.CreatedAt)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var pending = new List<DistributedInvalidationEvent>(rows.Count);
        foreach (DistributedInvalidationConvergenceObligationEntity row in rows)
        {
            string[] required = ParseNodes(row.RequiredNodeIds);
            string[] acked = ParseNodes(row.AckedNodeIds);
            if (!required.Contains(targetNodeId, StringComparer.Ordinal)
                || acked.Contains(targetNodeId, StringComparer.Ordinal))
            {
                continue;
            }
            if (string.IsNullOrWhiteSpace(row.PayloadJson)
                || !string.Equals(Digest(row.PayloadJson), row.PayloadDigest, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("distributed_invalidation_outbox_payload_unavailable");
            }
            DistributedInvalidationEvent invalidation =
                JsonSerializer.Deserialize<DistributedInvalidationEvent>(row.PayloadJson, s_json)
                ?? throw new InvalidOperationException("distributed_invalidation_outbox_payload_invalid");
            invalidation.Validate();
            pending.Add(invalidation);
        }
        return pending;
    }

    public async Task<DistributedInvalidationEvent?> ReadInboxEventAsync(
        string runtimeScope,
        string eventId,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DistributedInvalidationInboxEntity? inbox = await db
            .Queryable<DistributedInvalidationInboxEntity>()
            .Where(row => row.RuntimeScope == runtimeScope
                && row.EventId == eventId
                && row.TargetNodeId == targetNodeId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (inbox is null)
        {
            return null;
        }
        return await ReadEventFromOutboxAsync(
            runtimeScope,
            eventId,
            inbox.PayloadDigest,
            cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<DistributedInvalidationEvent>> ReadPendingInboxForNodeAsync(
        string runtimeScope,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<DistributedInvalidationInboxEntity> rows = await db
            .Queryable<DistributedInvalidationInboxEntity>()
            .Where(row => row.RuntimeScope == runtimeScope
                && row.TargetNodeId == targetNodeId
                && (row.ApplyState == InboxPendingState || row.ApplyState == InboxRetryableFailedState))
            .OrderBy(row => row.ReceivedAt)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var pending = new List<DistributedInvalidationEvent>(rows.Count);
        foreach (DistributedInvalidationInboxEntity row in rows)
        {
            pending.Add(await ReadEventFromOutboxAsync(
                runtimeScope,
                row.EventId,
                row.PayloadDigest,
                cancellationToken).ConfigureAwait(false));
        }
        return pending;
    }

    public async Task<DistributedInvalidationPendingInboxSnapshot> ReadPendingInboxSnapshotAsync(
        string runtimeScope,
        string targetNodeId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            List<DistributedInvalidationInboxEntity> rows = await db
                .Queryable<DistributedInvalidationInboxEntity>()
                .Where(row => row.RuntimeScope == runtimeScope
                    && row.TargetNodeId == targetNodeId
                    && (row.ApplyState == InboxPendingState || row.ApplyState == InboxRetryableFailedState))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            TimeSpan? oldest = rows.Count == 0
                ? null
                : timeProvider.GetUtcNow().UtcDateTime - rows.Min(row => row.ReceivedAt);
            return new DistributedInvalidationPendingInboxSnapshot(rows.Count, oldest, true);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch
        {
            return new DistributedInvalidationPendingInboxSnapshot(0, null, false);
        }
    }

    public async Task RecordFullReconcileObligationAsync(
        string runtimeScope,
        string targetNodeId,
        string reason,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateNodeId(targetNodeId);
        if (string.IsNullOrWhiteSpace(runtimeScope) || string.IsNullOrWhiteSpace(reason))
        {
            throw new InvalidOperationException("distributed_invalidation_full_reconcile_contract_invalid");
        }
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO distributed_invalidation_full_reconcile (
                runtime_scope,
                target_node_id,
                reason,
                overflow_count,
                triggered_at,
                resolved_at)
            VALUES (
                @RuntimeScope,
                @TargetNodeId,
                @Reason,
                1,
                @TriggeredAt,
                NULL)
            ON CONFLICT (runtime_scope, target_node_id)
            DO UPDATE SET
                overflow_count = distributed_invalidation_full_reconcile.overflow_count + 1,
                triggered_at = EXCLUDED.triggered_at,
                resolved_at = NULL;
            """,
            new SugarParameter("@RuntimeScope", runtimeScope),
            new SugarParameter("@TargetNodeId", targetNodeId),
            new SugarParameter("@Reason", reason.Trim()),
            new SugarParameter("@TriggeredAt", now)).ConfigureAwait(false);
    }

    public async Task RetireNodeAsync(
        string runtimeScope,
        string retiredNodeId,
        DistributedInvalidationTopologyManifest replacementTopology,
        string reason,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateNodeId(retiredNodeId);
        if (string.IsNullOrWhiteSpace(runtimeScope)
            || string.IsNullOrWhiteSpace(reason)
            || replacementTopology.SubscriberNodeIds.Contains(retiredNodeId, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_retirement_contract_invalid");
        }

        List<DistributedInvalidationConvergenceObligationEntity> affected = await db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(row => row.RuntimeScope == runtimeScope
                && (row.State == PendingState || row.State == PartiallyAckedState))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        foreach (DistributedInvalidationConvergenceObligationEntity row in affected)
        {
            string[] required = ParseNodes(row.RequiredNodeIds);
            if (!required.Contains(retiredNodeId, StringComparer.Ordinal))
            {
                continue;
            }
            string[] expectedReplacement = required
                .Where(node => !string.Equals(node, retiredNodeId, StringComparison.Ordinal))
                .ToArray();
            if (!NodeSetEquals(
                    replacementTopology.SubscriberNodeIds.Order(StringComparer.Ordinal).ToArray(),
                    expectedReplacement))
            {
                throw new InvalidOperationException("distributed_invalidation_retirement_topology_mismatch");
            }
        }

        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO distributed_invalidation_topology_retirement (
                    runtime_scope,
                    retired_node_id,
                    replacement_topology_digest,
                    reason,
                    recorded_at)
                VALUES (
                    @RuntimeScope,
                    @RetiredNodeId,
                    @ReplacementTopologyDigest,
                    @Reason,
                    @RecordedAt)
                ON CONFLICT (runtime_scope, retired_node_id, replacement_topology_digest)
                DO UPDATE SET reason = EXCLUDED.reason, recorded_at = EXCLUDED.recorded_at;
                """,
                new SugarParameter("@RuntimeScope", runtimeScope),
                new SugarParameter("@RetiredNodeId", retiredNodeId),
                new SugarParameter("@ReplacementTopologyDigest", replacementTopology.Digest),
                new SugarParameter("@Reason", reason.Trim()),
                new SugarParameter("@RecordedAt", now)).ConfigureAwait(false);
            await db.Ado.ExecuteCommandAsync(
                """
                UPDATE distributed_invalidation_convergence_obligation
                SET required_node_ids = (
                        SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)::text
                        FROM jsonb_array_elements_text(required_node_ids::jsonb) required(value)
                        WHERE required.value <> @RetiredNodeId),
                    required_topology_digest = @ReplacementTopologyDigest,
                    state = CASE
                        WHEN NOT EXISTS (
                            SELECT 1
                            FROM jsonb_array_elements_text(required_node_ids::jsonb) required(value)
                            WHERE required.value <> @RetiredNodeId
                              AND required.value NOT IN (
                                  SELECT jsonb_array_elements_text(acked_node_ids::jsonb)))
                        THEN 'complete'
                        ELSE 'partially-acked'
                    END
                WHERE runtime_scope = @RuntimeScope
                  AND state IN ('pending', 'partially-acked')
                  AND required_node_ids::jsonb ? @RetiredNodeId;
                """,
                new SugarParameter("@RetiredNodeId", retiredNodeId),
                new SugarParameter("@ReplacementTopologyDigest", replacementTopology.Digest),
                new SugarParameter("@RuntimeScope", runtimeScope)).ConfigureAwait(false);
        }).ConfigureAwait(false);
        EnsureTransaction(transaction.IsSuccess, transaction.ErrorException);
        runtimeState.Record(await SnapshotAsync(cancellationToken).ConfigureAwait(false));
    }

    public async Task RecordReconcileCoverageAsync(
        string runtimeScope,
        string targetNodeId,
        string kind,
        long generation,
        string proofIdentity,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        ValidateNodeId(targetNodeId);
        if (string.IsNullOrWhiteSpace(runtimeScope)
            || !DistributedInvalidationEventKinds.All.Contains(kind)
            || generation <= 0
            || string.IsNullOrWhiteSpace(proofIdentity))
        {
            throw new InvalidOperationException("distributed_invalidation_reconcile_coverage_invalid");
        }
        string proofDigest = Digest(string.Join(
            '\n',
            runtimeScope,
            targetNodeId,
            kind,
            generation.ToString(System.Globalization.CultureInfo.InvariantCulture),
            proofIdentity.Trim()));
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO distributed_invalidation_reconcile_coverage (
                runtime_scope,
                target_node_id,
                kind,
                generation,
                proof_digest,
                covered_at)
            VALUES (
                @RuntimeScope,
                @TargetNodeId,
                @Kind,
                @Generation,
                @ProofDigest,
                @CoveredAt)
            ON CONFLICT (runtime_scope, target_node_id, kind)
            DO UPDATE SET
                generation = EXCLUDED.generation,
                proof_digest = EXCLUDED.proof_digest,
                covered_at = EXCLUDED.covered_at
            WHERE distributed_invalidation_reconcile_coverage.generation <= EXCLUDED.generation;
            """,
            new SugarParameter("@RuntimeScope", runtimeScope),
            new SugarParameter("@TargetNodeId", targetNodeId),
            new SugarParameter("@Kind", kind),
            new SugarParameter("@Generation", generation),
            new SugarParameter("@ProofDigest", proofDigest.ToLowerInvariant()),
            new SugarParameter("@CoveredAt", timeProvider.GetUtcNow().UtcDateTime)).ConfigureAwait(false);
    }

    public async Task<int> CompactCompletedAsync(
        string runtimeScope,
        long generationWatermark,
        DateTimeOffset retainAfter,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (generationWatermark <= 0)
        {
            throw new InvalidOperationException("distributed_invalidation_reconcile_generation_required");
        }
        List<DistributedInvalidationConvergenceObligationEntity> rows = await db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(row => row.RuntimeScope == runtimeScope
                && row.State == CompleteState
                && row.CreatedAt <= retainAfter.UtcDateTime
                && row.CompactedAt == null)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        int compacted = 0;
        foreach (DistributedInvalidationConvergenceObligationEntity row in rows)
        {
            string[] targets = ParseNodes(row.RequiredNodeIds)
                .Where(node => !string.Equals(node, row.SourceNodeId, StringComparison.Ordinal))
                .ToArray();
            if (targets.Length == 0)
            {
                continue;
            }
            List<DistributedInvalidationInboxEntity> inboxes = await db
                .Queryable<DistributedInvalidationInboxEntity>()
                .Where(inbox => inbox.RuntimeScope == runtimeScope && inbox.EventId == row.EventId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            List<DistributedInvalidationReconcileCoverageEntity> coverage = await db
                .Queryable<DistributedInvalidationReconcileCoverageEntity>()
                .Where(item => item.RuntimeScope == runtimeScope && item.Kind == row.Kind)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            bool applied = targets.All(target => inboxes.Any(inbox =>
                string.Equals(inbox.TargetNodeId, target, StringComparison.Ordinal)
                && inbox.ApplyState == InboxAppliedState));
            bool scopeKindCovered = targets.All(target => coverage.Any(item =>
                string.Equals(item.TargetNodeId, target, StringComparison.Ordinal)
                && item.Generation >= generationWatermark
                && item.ProofDigest.Length == 64));
            if (!applied || !scopeKindCovered)
            {
                continue;
            }

            int changed = await db.Ado.ExecuteCommandAsync(
                """
                UPDATE distributed_invalidation_convergence_obligation
                SET payload_json = NULL,
                    reconcile_generation = @Generation,
                    compacted_at = @CompactedAt
                WHERE id = @Id
                  AND state = 'complete'
                  AND compacted_at IS NULL;
                """,
                new SugarParameter("@Generation", generationWatermark),
                new SugarParameter("@CompactedAt", timeProvider.GetUtcNow().UtcDateTime),
                new SugarParameter("@Id", row.Id)).ConfigureAwait(false);
            compacted += changed;
        }
        return compacted;
    }

    public async Task<DistributedInvalidationConvergenceSnapshot> SnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            List<DistributedInvalidationConvergenceObligationEntity> rows = await db
                .Queryable<DistributedInvalidationConvergenceObligationEntity>()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            DistributedInvalidationConvergenceObligationEntity[] pending = rows
                .Where(row => row.State is PendingState or PartiallyAckedState)
                .ToArray();
            int terminalFailed = rows.Count(row => row.State == TerminalFailedState
                || row.State is "PendingRedelivery" or "PendingFullReconcile" or "TerminalFailed");
            int ackGap = pending.Sum(row =>
            {
                string[] acked = ParseNodes(row.AckedNodeIds);
                return ParseNodes(row.RequiredNodeIds)
                    .Count(required => !acked.Contains(required, StringComparer.Ordinal));
            });
            TimeSpan? oldest = pending.Length == 0
                ? null
                : now - pending.Min(row => row.CreatedAt);
            var snapshot = new DistributedInvalidationConvergenceSnapshot(
                pending.Length,
                terminalFailed,
                oldest,
                pending.Length > 0 || terminalFailed > 0 || ackGap > 0,
                ackGap,
                true);
            runtimeState.Record(snapshot);
            return snapshot;
        }
        catch
        {
            runtimeState.RecordUnavailable();
            throw;
        }
    }

    private async Task<DistributedInvalidationConvergenceObligationEntity> FindOutboxAsync(
        string runtimeScope,
        string eventId,
        CancellationToken cancellationToken)
        => await db.Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(row => row.RuntimeScope == runtimeScope && row.EventId == eventId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("distributed_invalidation_outbox_required");

    private async Task<DistributedInvalidationInboxEntity> FindInboxAsync(
        string runtimeScope,
        string eventId,
        string targetNodeId,
        CancellationToken cancellationToken)
        => await db.Queryable<DistributedInvalidationInboxEntity>()
            .Where(row => row.RuntimeScope == runtimeScope
                && row.EventId == eventId
                && row.TargetNodeId == targetNodeId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("distributed_invalidation_inbox_required");

    private async Task<DistributedInvalidationEvent> ReadEventFromOutboxAsync(
        string runtimeScope,
        string eventId,
        string expectedPayloadDigest,
        CancellationToken cancellationToken)
    {
        DistributedInvalidationConvergenceObligationEntity outbox = await FindOutboxAsync(
            runtimeScope,
            eventId,
            cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(outbox.PayloadJson)
            || !string.Equals(Digest(outbox.PayloadJson), expectedPayloadDigest, StringComparison.Ordinal)
            || !string.Equals(Digest(outbox.PayloadJson), outbox.PayloadDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_outbox_payload_unavailable");
        }
        DistributedInvalidationEvent invalidation =
            JsonSerializer.Deserialize<DistributedInvalidationEvent>(outbox.PayloadJson, s_json)
            ?? throw new InvalidOperationException("distributed_invalidation_outbox_payload_invalid");
        invalidation.Validate();
        return invalidation;
    }

    private static DistributedInvalidationEvent ValidatePublishResult(DistributedInvalidationPublishResult result)
    {
        DistributedInvalidationEvent invalidation = result.Event
            ?? throw new InvalidOperationException("distributed_invalidation_outbox_event_required");
        if (!string.Equals(result.EventId, invalidation.EventId, StringComparison.Ordinal)
            || result.TransportReceipt is null)
        {
            throw new InvalidOperationException("distributed_invalidation_outbox_publish_receipt_required");
        }
        bool delivered = result.Status == DistributedInvalidationPublishStatus.Published
            && result.TransportReceipt.TransportStatus == DistributedInvalidationTransportStatus.Delivered;
        bool degraded = result.Status == DistributedInvalidationPublishStatus.Degraded
            && result.TransportReceipt.TransportStatus is DistributedInvalidationTransportStatus.UnderDelivered
                or DistributedInvalidationTransportStatus.TransportFailed;
        if (!delivered && !degraded)
        {
            throw new InvalidOperationException("distributed_invalidation_outbox_publish_receipt_mismatch");
        }
        return invalidation;
    }

    private static DistributedInvalidationConvergenceObligation ToContract(
        DistributedInvalidationConvergenceObligationEntity row)
        => new(
            row.ObligationId,
            row.EventId,
            row.Kind,
            row.SourceNodeId,
            row.RuntimeScope,
            row.SourceMutationIdentity,
            row.RequiredTopologyDigest,
            Enum.Parse<DistributedInvalidationPublishStatus>(row.PublishStatus),
            Enum.TryParse(row.TransportStatus, out DistributedInvalidationTransportStatus transport) ? transport : null,
            new DateTimeOffset(DateTime.SpecifyKind(row.CreatedAt, DateTimeKind.Utc)),
            ParseOutboxState(row.State),
            row.AttemptCount,
            row.LastFailureKind,
            row.PayloadDigest ?? string.Empty,
            ParseNodes(row.RequiredNodeIds),
            ParseNodes(row.AckedNodeIds));

    private static DistributedInvalidationConvergenceState ParseOutboxState(string state)
        => state switch
        {
            PendingState => DistributedInvalidationConvergenceState.Pending,
            PartiallyAckedState => DistributedInvalidationConvergenceState.PartiallyAcked,
            CompleteState => DistributedInvalidationConvergenceState.Complete,
            TerminalFailedState => DistributedInvalidationConvergenceState.TerminalFailed,
            "Satisfied" => DistributedInvalidationConvergenceState.Complete,
            "PendingRedelivery" or "PendingFullReconcile" or "TerminalFailed"
                => DistributedInvalidationConvergenceState.TerminalFailed,
            _ => throw new InvalidOperationException("distributed_invalidation_outbox_state_invalid")
        };

    private static DistributedInvalidationInboxApplyState ParseInboxState(string state)
        => state switch
        {
            InboxPendingState => DistributedInvalidationInboxApplyState.Pending,
            InboxApplyingState => DistributedInvalidationInboxApplyState.Applying,
            InboxAppliedState => DistributedInvalidationInboxApplyState.Applied,
            InboxRetryableFailedState => DistributedInvalidationInboxApplyState.RetryableFailed,
            InboxTerminalFailedState => DistributedInvalidationInboxApplyState.TerminalFailed,
            _ => throw new InvalidOperationException("distributed_invalidation_inbox_state_invalid")
        };

    private static string FormatInboxState(DistributedInvalidationInboxApplyState state)
        => state switch
        {
            DistributedInvalidationInboxApplyState.Applied => InboxAppliedState,
            DistributedInvalidationInboxApplyState.RetryableFailed => InboxRetryableFailedState,
            DistributedInvalidationInboxApplyState.TerminalFailed => InboxTerminalFailedState,
            _ => throw new InvalidOperationException("distributed_invalidation_inbox_terminal_transition_required")
        };

    private static string[] ParseNodes(string? json)
        => string.IsNullOrWhiteSpace(json)
            ? []
            : JsonSerializer.Deserialize<string[]>(json, s_json)?
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
                .ToArray()
                ?? [];

    private static bool NodeSetEquals(IReadOnlyList<string> left, IReadOnlyList<string> right)
        => left.Count == right.Count && left.SequenceEqual(right, StringComparer.Ordinal);

    private static void ValidateNodeId(string nodeId)
    {
        if (string.IsNullOrWhiteSpace(nodeId))
        {
            throw new InvalidOperationException("distributed_invalidation_node_id_required");
        }
    }

    private static void EnsureTransaction(bool succeeded, Exception? exception)
    {
        if (!succeeded)
        {
            throw new InvalidOperationException("distributed_invalidation_ledger_transaction_failed", exception);
        }
    }

    private static string Digest(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static string ComputeSourceMutationIdentity(DistributedInvalidationEvent invalidation)
    {
        string canonical = JsonSerializer.Serialize(new SourceMutationIdentity(
            invalidation.Kind,
            invalidation.CacheTags,
            invalidation.RouteKeys,
            invalidation.ArtifactKeys));
        return Digest(canonical);
    }

    private sealed record SourceMutationIdentity(
        string Kind,
        IReadOnlyList<string> CacheTags,
        IReadOnlyList<string> RouteKeys,
        IReadOnlyList<string> ArtifactKeys);
}
