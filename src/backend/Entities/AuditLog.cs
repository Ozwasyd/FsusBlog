using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_audit_log")]
[SugarIndex("idx_audit_occurred_at_desc", nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_source_time", nameof(Source), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_type_time", nameof(Type), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_action_time", nameof(Action), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_actor_time", nameof(ActorId), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_target_time", nameof(TargetType), OrderByType.Asc, nameof(TargetId), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_outcome_time", nameof(Outcome), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_chain_tail", nameof(ChainId), OrderByType.Asc, nameof(Id), OrderByType.Desc, false)]
public sealed class AuditLog
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source", Length = 64)]
    public string Source { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "type", Length = 32)]
    public string Type { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_type", Length = 32, IsNullable = true)]
    public string? ActorType
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_id", Length = 64, IsNullable = true)]
    public string? ActorId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_role", Length = 32, IsNullable = true)]
    public string? ActorRole
    {
        get; set;
    }

    [SugarColumn(ColumnName = "action", Length = 96)]
    public string Action { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "target_type", Length = 64, IsNullable = true)]
    public string? TargetType
    {
        get; set;
    }

    [SugarColumn(ColumnName = "target_id", Length = 128, IsNullable = true)]
    public string? TargetId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "outcome", Length = 32)]
    public string Outcome { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "severity", Length = 32)]
    public string Severity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "is_high_value")]
    public bool IsHighValue
    {
        get; set;
    }

    [SugarColumn(ColumnName = "trace_id", Length = 128, IsNullable = true)]
    public string? TraceId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "request_path", Length = 256, IsNullable = true)]
    public string? RequestPath
    {
        get; set;
    }

    [SugarColumn(ColumnName = "request_method", Length = 16, IsNullable = true)]
    public string? RequestMethod
    {
        get; set;
    }

    [SugarColumn(ColumnName = "ip_hash", Length = 64, IsNullable = true)]
    public string? IpHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "user_agent_hash", Length = 64, IsNullable = true)]
    public string? UserAgentHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "session_id_hash", Length = 64, IsNullable = true)]
    public string? SessionIdHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "device_fingerprint_hash", Length = 64, IsNullable = true)]
    public string? DeviceFingerprintHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reason_code", Length = 64, IsNullable = true)]
    public string? ReasonCode
    {
        get; set;
    }

    [SugarColumn(ColumnName = "event_info", ColumnDataType = "text")]
    public string EventInfo { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "context_payload", ColumnDataType = "bytea", IsNullable = true)]
    public byte[]? ContextPayload
    {
        get; set;
    }

    [SugarColumn(ColumnName = "context_json", ColumnDataType = "text", IsNullable = true)]
    public string? ContextJson
    {
        get; set;
    }

    [SugarColumn(ColumnName = "chain_id", Length = 32, IsNullable = true)]
    public string? ChainId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "prev_hash", Length = 64, IsNullable = true)]
    public string? PrevHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "record_hash", Length = 64, IsNullable = true)]
    public string? RecordHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "record_mac", Length = 64, IsNullable = true)]
    public string? RecordMac
    {
        get; set;
    }
}

[SugarTable("frontend_rum_metric")]
[SugarIndex("idx_rum_occurred_at_desc", nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_rum_name_time", nameof(Name), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_rum_page_type_time", nameof(PageType), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
public sealed class FrontendRumMetric
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "name", Length = 64)]
    public string Name { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "page_type", Length = 32)]
    public string PageType { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "aot_source", Length = 32)]
    public string AotSource { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "value", IsNullable = true)]
    public double? Value
    {
        get; set;
    }

    [SugarColumn(ColumnName = "metrics_json", ColumnDataType = "text")]
    public string MetricsJson { get; set; } = "{}";

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}
