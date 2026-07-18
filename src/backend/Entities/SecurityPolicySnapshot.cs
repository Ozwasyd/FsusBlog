using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("security_policy_snapshot")]
[SugarIndex("unique_idx_security_policy_snapshot_policy_version", nameof(PolicyId), OrderByType.Asc, nameof(Version), OrderByType.Asc, true)]
[SugarIndex("idx_security_policy_snapshot_lkg", nameof(PolicyId), OrderByType.Asc, nameof(IsLastKnownGood), OrderByType.Asc, nameof(Version), OrderByType.Desc)]
public sealed class SecurityPolicySnapshot
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_id", Length = 64)]
    public string PolicyId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "version")]
    public long Version
    {
        get; set;
    }

    [SugarColumn(ColumnName = "mode", Length = 32)]
    public string Mode { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "document", ColumnDataType = "text")]
    public string Document { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_by_admin_id", IsNullable = true)]
    public long? CreatedByAdminId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "activated_at_utc", IsNullable = true)]
    public DateTime? ActivatedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revoked_at_utc", IsNullable = true)]
    public DateTime? RevokedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "is_last_known_good")]
    public bool IsLastKnownGood
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rollback_of_version", IsNullable = true)]
    public long? RollbackOfVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reason", Length = 128, IsNullable = true)]
    public string? Reason
    {
        get; set;
    }
}

[SugarTable("security_policy_version_counter")]
public sealed class SecurityPolicyVersionCounter
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "policy_id", Length = 64)]
    public string PolicyId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "last_version")]
    public long LastVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
