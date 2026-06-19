using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_credential_issuance_audit")]
[SugarIndex("idx_anonymous_credential_issuance_user", nameof(UserId), OrderByType.Asc)]
[SugarIndex("unique_idx_anonymous_credential_issuance_user_epoch", nameof(UserId), OrderByType.Asc, nameof(Epoch), OrderByType.Asc, true)]
[SugarIndex("idx_anonymous_credential_issuance_epoch", nameof(Epoch), OrderByType.Asc)]
public sealed class AnonymousCredentialIssuanceAudit
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "user_id")]
    public int UserId { get; set; }

    [SugarColumn(ColumnName = "epoch")]
    public long Epoch { get; set; }

    [SugarColumn(ColumnName = "request_hash", Length = 64)]
    public string RequestHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = AnonymousCredentialIssuanceStatuses.Issued;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "trace_id", Length = 64, IsNullable = true)]
    public string? TraceId { get; set; }
}

public static class AnonymousCredentialIssuanceStatuses
{
    public const string Issued = "issued";
}
