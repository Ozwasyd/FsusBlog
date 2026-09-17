using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("security_risk_event")]
[SugarIndex("idx_security_risk_event_source_reason_action", nameof(Source), OrderByType.Asc, nameof(Reason), OrderByType.Asc, nameof(Action), OrderByType.Asc)]
[SugarIndex("idx_security_risk_event_subject", nameof(SubjectHash), OrderByType.Asc)]
[SugarIndex("idx_security_risk_event_client_ip", nameof(ClientIpHash), OrderByType.Asc)]
[SugarIndex("idx_security_risk_event_device", nameof(DeviceFpHash), OrderByType.Asc)]
[SugarIndex("idx_security_risk_event_expires", nameof(ExpiresAtUtc), OrderByType.Asc)]
[SugarIndex("idx_security_risk_event_epoch", nameof(PseudonymEpoch), OrderByType.Asc)]
public sealed class SecurityRiskEvent
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "id", Length = 64)]
    public string Id { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source", Length = 64)]
    public string Source { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "reason", Length = 64)]
    public string Reason { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "action", Length = 96)]
    public string Action { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "score_delta")]
    public int ScoreDelta
    {
        get; set;
    }

    [SugarColumn(ColumnName = "total_score")]
    public int TotalScore
    {
        get; set;
    }

    [SugarColumn(ColumnName = "ttl_seconds")]
    public int TtlSeconds
    {
        get; set;
    }

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "subject_hash", Length = 64, IsNullable = true)]
    public string? SubjectHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "route_key", Length = 160, IsNullable = true)]
    public string? RouteKey
    {
        get; set;
    }

    [SugarColumn(ColumnName = "client_ip_hash", Length = 64, IsNullable = true)]
    public string? ClientIpHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "device_fp_hash", Length = 64, IsNullable = true)]
    public string? DeviceFpHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "path", Length = 256, IsNullable = true)]
    public string? Path
    {
        get; set;
    }

    [SugarColumn(ColumnName = "method", Length = 16, IsNullable = true)]
    public string? Method
    {
        get; set;
    }

    [SugarColumn(ColumnName = "user_agent", Length = 256, IsNullable = true)]
    public string? UserAgent
    {
        get; set;
    }

    [SugarColumn(ColumnName = "detail", Length = 256, IsNullable = true)]
    public string? Detail
    {
        get; set;
    }

    [SugarColumn(ColumnName = "trace_id", Length = 64, IsNullable = true)]
    public string? TraceId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "pseudonym_epoch", DefaultValue = "0")]
    public int PseudonymEpoch
    {
        get; set;
    }
}
