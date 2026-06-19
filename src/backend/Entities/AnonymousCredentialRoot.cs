using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_credential_root")]
[SugarIndex("idx_anonymous_credential_root_status_expires", nameof(Status), OrderByType.Asc, nameof(GraceExpiresAtUtc), OrderByType.Asc)]
[SugarIndex("idx_anonymous_credential_root_circuit", nameof(CircuitId), OrderByType.Asc)]
[SugarIndex("idx_anonymous_credential_root_status_epoch", nameof(Status), OrderByType.Asc, nameof(Epoch), OrderByType.Desc)]
[SugarIndex("unique_idx_anonymous_credential_root_hash", nameof(RootHash), OrderByType.Asc, true)]
public sealed class AnonymousCredentialRoot
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "epoch")]
    public long Epoch { get; set; }

    [SugarColumn(ColumnName = "root_hash", Length = 128)]
    public string RootHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "revocation_root_hash", Length = 128)]
    public string RevocationRootHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "circuit_id", Length = 96)]
    public string CircuitId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "circuit_numeric_id")]
    public int CircuitNumericId { get; set; }

    [SugarColumn(ColumnName = "verifying_key_hash", Length = 128)]
    public string VerifyingKeyHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "issuer_public_key_hash", Length = 128)]
    public string IssuerPublicKeyHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "public_input_layout_version")]
    public int PublicInputLayoutVersion { get; set; }

    [SugarColumn(ColumnName = "circuit_metadata", ColumnDataType = "text", IsNullable = true)]
    public string? CircuitMetadata { get; set; }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "activated_at_utc", IsNullable = true)]
    public DateTime? ActivatedAtUtc { get; set; }

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc { get; set; }

    [SugarColumn(ColumnName = "root_grace_expires_at_utc")]
    public DateTime GraceExpiresAtUtc { get; set; }

    [SugarColumn(ColumnName = "revoked_at_utc", IsNullable = true)]
    public DateTime? RevokedAtUtc { get; set; }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = AnonymousCredentialRootStatuses.Active;

    [SugarColumn(ColumnName = "revoke_reason", Length = 128, IsNullable = true)]
    public string? RevokeReason { get; set; }
}

public static class AnonymousCredentialRootStatuses
{
    public const string Draft = "draft";
    public const string Active = "active";
    public const string Grace = "grace";
    public const string Expired = "expired";
    public const string Revoked = "revoked";

    public const string Pending = Draft;
    public const string Retired = Expired;
}
