using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("admin_audit_log")]
[SugarIndex("idx_admin_audit_time", nameof(OccurredAtUtc), OrderByType.Desc)]
[SugarIndex("idx_admin_audit_principal_time", nameof(AdminPrincipalId), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
[SugarIndex("idx_admin_audit_action_time", nameof(Action), OrderByType.Asc, nameof(OccurredAtUtc), OrderByType.Desc, false)]
public sealed class AdminAuditLog
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? AdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? AdminSessionId
    {
        get; set;
    }

    [SugarColumn(Length = 96)]
    public string Action { get; set; } = string.Empty;

    [SugarColumn(Length = 32)]
    public string Outcome { get; set; } = string.Empty;

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? TargetType
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 128)]
    public string? TargetId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? IpHash
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? UserAgentHash
    {
        get; set;
    }

    [SugarColumn(DefaultValue = "false")]
    public bool IsHighImpact
    {
        get; set;
    }

    [SugarColumn(ColumnDataType = "text")]
    public string MetadataJson { get; set; } = "{}";

    public DateTime OccurredAtUtc { get; set; } = DateTime.UtcNow;
}
