using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_audit_log")]
[SugarIndex("idx_audit_occurred_at_desc", nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_source_time", nameof(Source), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_audit_type_time", nameof(Type), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
public sealed class AuditLog
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "source", Length = 64)]
    public string Source { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "type", Length = 32)]
    public string Type { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc { get; set; }

    [SugarColumn(ColumnName = "event_info", ColumnDataType = "text")]
    public string EventInfo { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "context_payload", ColumnDataType = "bytea", IsNullable = true)]
    public byte[]? ContextPayload { get; set; }
}
