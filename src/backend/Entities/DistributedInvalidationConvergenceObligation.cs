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
}
