using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed class DistributedInvalidationConvergenceObligationStore(
    ISqlSugarClient db,
    TimeProvider timeProvider,
    DistributedInvalidationConvergenceRuntimeState runtimeState) : IDistributedInvalidationObligationStore
{
    public async Task<DistributedInvalidationConvergenceObligation> UpsertAsync(DistributedInvalidationPublishResult result, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DistributedInvalidationEvent invalidation = result.Event
            ?? throw new InvalidOperationException("distributed_invalidation_obligation_event_required");
        if (!string.Equals(result.EventId, invalidation.EventId, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_obligation_event_identity_mismatch");
        }

        DistributedInvalidationTransportPublishResult transport = result.TransportReceipt
            ?? throw new InvalidOperationException("distributed_invalidation_obligation_transport_receipt_required");
        string topology = transport.TopologyDigest
            ?? throw new InvalidOperationException("distributed_invalidation_obligation_topology_required");
        bool delivered = result.Status == DistributedInvalidationPublishStatus.Published
            && transport.TransportStatus == DistributedInvalidationTransportStatus.Delivered;
        bool degraded = result.Status == DistributedInvalidationPublishStatus.Degraded
            && transport.TransportStatus is DistributedInvalidationTransportStatus.UnderDelivered
                or DistributedInvalidationTransportStatus.TransportFailed;
        if (!delivered && !degraded)
        {
            throw new InvalidOperationException("distributed_invalidation_obligation_publish_receipt_mismatch");
        }

        string identity = ComputeSourceMutationIdentity(invalidation);
        string obligationId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{invalidation.RuntimeScope}:{invalidation.EventId}"))).ToLowerInvariant();
        DistributedInvalidationConvergenceState state = delivered
            ? DistributedInvalidationConvergenceState.Satisfied
            : DistributedInvalidationConvergenceState.PendingRedelivery;
        DateTime createdAt = timeProvider.GetUtcNow().UtcDateTime;
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
                created_at)
            VALUES (
                @ObligationId,
                @EventId,
                @Kind,
                @SourceNodeId,
                @RuntimeScope,
                @SourceMutationIdentity,
                @RequiredTopologyDigest,
                @PublishStatus,
                @TransportStatus,
                @State,
                1,
                @LastFailureKind,
                @CreatedAt)
            ON CONFLICT (runtime_scope, event_id) DO NOTHING;
            """,
            new SugarParameter("@ObligationId", obligationId),
            new SugarParameter("@EventId", invalidation.EventId),
            new SugarParameter("@Kind", invalidation.Kind),
            new SugarParameter("@SourceNodeId", invalidation.SourceNodeId),
            new SugarParameter("@RuntimeScope", invalidation.RuntimeScope),
            new SugarParameter("@SourceMutationIdentity", identity),
            new SugarParameter("@RequiredTopologyDigest", topology),
            new SugarParameter("@PublishStatus", result.Status.ToString()),
            new SugarParameter("@TransportStatus", transport.TransportStatus.ToString()),
            new SugarParameter("@State", state.ToString()),
            new SugarParameter("@LastFailureKind", result.Detail ?? (object)DBNull.Value),
            new SugarParameter("@CreatedAt", createdAt)).ConfigureAwait(false);
        DistributedInvalidationConvergenceObligationEntity existing = await db
            .Queryable<DistributedInvalidationConvergenceObligationEntity>()
            .Where(row => row.RuntimeScope == invalidation.RuntimeScope && row.EventId == invalidation.EventId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false)
            ?? throw new InvalidOperationException("distributed_invalidation_obligation_upsert_failed");
        if (existing.RequiredTopologyDigest != topology
            || existing.SourceMutationIdentity != identity
            || existing.Kind != invalidation.Kind
            || existing.SourceNodeId != invalidation.SourceNodeId
            || existing.RuntimeScope != invalidation.RuntimeScope)
        {
            throw new InvalidOperationException("distributed_invalidation_obligation_identity_mismatch");
        }
        runtimeState.Record(await SnapshotAsync(cancellationToken).ConfigureAwait(false));
        return ToContract(existing);
    }

    public async Task<DistributedInvalidationConvergenceSnapshot> SnapshotAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        List<DistributedInvalidationConvergenceObligationEntity> rows = await db.Queryable<DistributedInvalidationConvergenceObligationEntity>().ToListAsync();
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        var pending = rows.Where(row => row.State is "PendingRedelivery" or "PendingFullReconcile").ToArray();
        int failed = rows.Count(row => row.State == "TerminalFailed");
        TimeSpan? oldest = pending.Length == 0 ? null : now - pending.Min(row => row.CreatedAt);
        var snapshot = new DistributedInvalidationConvergenceSnapshot(pending.Length, failed, oldest, pending.Length > 0 || failed > 0);
        runtimeState.Record(snapshot);
        return snapshot;
    }

    private static DistributedInvalidationConvergenceObligation ToContract(DistributedInvalidationConvergenceObligationEntity row)
        => new(row.ObligationId, row.EventId, row.Kind, row.SourceNodeId, row.RuntimeScope, row.SourceMutationIdentity,
            row.RequiredTopologyDigest, Enum.Parse<DistributedInvalidationPublishStatus>(row.PublishStatus),
            Enum.TryParse(row.TransportStatus, out DistributedInvalidationTransportStatus transport) ? transport : null,
            new DateTimeOffset(DateTime.SpecifyKind(row.CreatedAt, DateTimeKind.Utc)),
            Enum.Parse<DistributedInvalidationConvergenceState>(row.State), row.AttemptCount, row.LastFailureKind);

    private static string ComputeSourceMutationIdentity(DistributedInvalidationEvent invalidation)
    {
        string canonical = JsonSerializer.Serialize(new SourceMutationIdentity(
            invalidation.Kind,
            invalidation.CacheTags,
            invalidation.RouteKeys,
            invalidation.ArtifactKeys));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }

    private sealed record SourceMutationIdentity(
        string Kind,
        IReadOnlyList<string> CacheTags,
        IReadOnlyList<string> RouteKeys,
        IReadOnlyList<string> ArtifactKeys);
}
