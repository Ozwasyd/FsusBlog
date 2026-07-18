using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_credential_revocation")]
[SugarIndex("unique_idx_anonymous_credential_revocation_epoch_handle", nameof(Epoch), OrderByType.Asc, nameof(RevocationHandleHash), OrderByType.Asc, true)]
public sealed class AnonymousCredentialRevocation
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "epoch")]
    public long Epoch
    {
        get; set;
    }

    [SugarColumn(ColumnName = "root_hash", Length = 128)]
    public string RootHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "revocation_handle_hash", Length = 128)]
    public string RevocationHandleHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "revocation_root_hash", Length = 128)]
    public string RevocationRootHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "reason", Length = 128, IsNullable = true)]
    public string? Reason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_id", Length = 128, IsNullable = true)]
    public string? ActorId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revoked_at_utc")]
    public DateTime RevokedAtUtc { get; set; } = DateTime.UtcNow;
}
