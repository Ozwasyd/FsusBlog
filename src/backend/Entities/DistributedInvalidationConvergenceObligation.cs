using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("distributed_invalidation_convergence_obligation")]
[SugarIndex("ux_distributed_invalidation_convergence_event", nameof(RuntimeScope), OrderByType.Asc, nameof(EventId), OrderByType.Asc, true)]
[SugarIndex("idx_distributed_invalidation_convergence_pending", nameof(State), OrderByType.Asc, nameof(CreatedAt), OrderByType.Asc)]
public sealed class DistributedInvalidationConvergenceObligationEntity
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "obligation_id", Length = 64)]
    public string ObligationId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "event_id", Length = 64)]
    public string EventId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "kind", Length = 64)]
    public string Kind
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "source_node_id", Length = 128)]
    public string SourceNodeId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "runtime_scope", Length = 128)]
    public string RuntimeScope
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "source_mutation_identity", Length = 256)]
    public string SourceMutationIdentity
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "required_topology_digest", Length = 128)]
    public string RequiredTopologyDigest
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "publish_status", Length = 32)]
    public string PublishStatus
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "transport_status", Length = 32, IsNullable = true)]
    public string? TransportStatus
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "state", Length = 32)]
    public string State
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "attempt_count")]
    public int AttemptCount
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "last_failure_kind", Length = 256, IsNullable = true)]
    public string? LastFailureKind
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "payload_digest", Length = 64, IsNullable = true)]
    public string? PayloadDigest
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "payload_json", ColumnDataType = "text", IsNullable = true)]
    public string? PayloadJson
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "required_node_ids", ColumnDataType = "text", IsNullable = true)]
    public string? RequiredNodeIds
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "acked_node_ids", ColumnDataType = "text", IsNullable = true)]
    public string? AckedNodeIds
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "last_attempt_at", IsNullable = true)]
    public DateTime? LastAttemptAt
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "reconcile_generation", IsNullable = true)]
    public long? ReconcileGeneration
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "compacted_at", IsNullable = true)]
    public DateTime? CompactedAt
    {
        get;
        set;
    }
}

[SugarTable("distributed_invalidation_inbox")]
[SugarIndex(
    "ux_distributed_invalidation_inbox_event",
    nameof(RuntimeScope),
    OrderByType.Asc,
    nameof(EventId),
    OrderByType.Asc,
    nameof(TargetNodeId),
    OrderByType.Asc,
    true)]
public sealed class DistributedInvalidationInboxEntity
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "event_id", Length = 64)]
    public string EventId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "runtime_scope", Length = 128)]
    public string RuntimeScope
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "target_node_id", Length = 128)]
    public string TargetNodeId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "payload_digest", Length = 64)]
    public string PayloadDigest
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "received_at")]
    public DateTime ReceivedAt
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "apply_state", Length = 32)]
    public string ApplyState
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "apply_attempt")]
    public int ApplyAttempt
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "last_failure_kind", Length = 256, IsNullable = true)]
    public string? LastFailureKind
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "applied_generation", IsNullable = true)]
    public long? AppliedGeneration
    {
        get;
        set;
    }
}

[SugarTable("distributed_invalidation_topology_retirement")]
[SugarIndex(
    "ux_distributed_invalidation_topology_retirement",
    nameof(RuntimeScope),
    OrderByType.Asc,
    nameof(RetiredNodeId),
    OrderByType.Asc,
    nameof(ReplacementTopologyDigest),
    OrderByType.Asc,
    true)]
public sealed class DistributedInvalidationTopologyRetirementEntity
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "runtime_scope", Length = 128)]
    public string RuntimeScope
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "retired_node_id", Length = 128)]
    public string RetiredNodeId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "replacement_topology_digest", Length = 128)]
    public string ReplacementTopologyDigest
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "reason", Length = 256)]
    public string Reason
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "recorded_at")]
    public DateTime RecordedAt
    {
        get;
        set;
    }
}

[SugarTable("distributed_invalidation_reconcile_coverage")]
[SugarIndex(
    "ux_distributed_invalidation_reconcile_coverage",
    nameof(RuntimeScope),
    OrderByType.Asc,
    nameof(TargetNodeId),
    OrderByType.Asc,
    nameof(Kind),
    OrderByType.Asc,
    true)]
public sealed class DistributedInvalidationReconcileCoverageEntity
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "runtime_scope", Length = 128)]
    public string RuntimeScope
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "target_node_id", Length = 128)]
    public string TargetNodeId
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "kind", Length = 64)]
    public string Kind
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "generation")]
    public long Generation
    {
        get;
        set;
    }

    [SugarColumn(ColumnName = "proof_digest", Length = 64)]
    public string ProofDigest
    {
        get;
        set;
    } = string.Empty;

    [SugarColumn(ColumnName = "covered_at")]
    public DateTime CoveredAt
    {
        get;
        set;
    }
}
