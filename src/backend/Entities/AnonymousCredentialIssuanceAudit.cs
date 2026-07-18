using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_credential_issuance_audit")]
[SugarIndex("idx_anonymous_credential_issuance_subject", nameof(SubjectHash), OrderByType.Asc)]
[SugarIndex("unique_idx_anonymous_credential_issuance_subject_epoch", nameof(SubjectHash), OrderByType.Asc, nameof(Epoch), OrderByType.Asc, true)]
[SugarIndex("idx_anonymous_credential_issuance_epoch", nameof(Epoch), OrderByType.Asc)]
public sealed class AnonymousCredentialIssuanceAudit
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "subject_hash", Length = 64)]
    public string SubjectHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "epoch")]
    public long Epoch
    {
        get; set;
    }

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = AnonymousCredentialIssuanceStatuses.Issued;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

}

public static class AnonymousCredentialIssuanceStatuses
{
    public const string Issued = "issued";
}
