using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_credential_epoch")]
[SugarIndex("unique_idx_anonymous_credential_epoch_epoch", nameof(Epoch), OrderByType.Asc, true)]
public sealed class AnonymousCredentialEpoch
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "epoch")]
    public long Epoch
    {
        get; set;
    }

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = AnonymousCredentialRootStatuses.Draft;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "activated_at_utc", IsNullable = true)]
    public DateTime? ActivatedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "root_grace_expires_at_utc")]
    public DateTime GraceExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "active_root_hash", Length = 128, IsNullable = true)]
    public string? ActiveRootHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reason", Length = 128, IsNullable = true)]
    public string? Reason
    {
        get; set;
    }
}
