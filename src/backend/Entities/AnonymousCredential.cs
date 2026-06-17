using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_credential")]
[SugarIndex("idx_anonymous_credential_user", nameof(UserId), OrderByType.Asc)]
[SugarIndex("unique_idx_anonymous_credential_commitment", nameof(CommitmentHash), OrderByType.Asc, true)]
[SugarIndex("idx_anonymous_credential_status", nameof(Status), OrderByType.Asc)]
public sealed class AnonymousCredential
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "user_id", IsNullable = true)]
    public int? UserId { get; set; }

    [SugarColumn(ColumnName = "commitment_hash", Length = 128)]
    public string CommitmentHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "credential_type", Length = 32)]
    public string CredentialType { get; set; } = AnonymousCredentialTypes.AccountBound;

    [SugarColumn(ColumnName = "credential_level", Length = 32)]
    public string CredentialLevel { get; set; } = AnonymousCredentialLevels.Basic;

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = AnonymousCredentialStatuses.Active;

    [SugarColumn(ColumnName = "issued_at_utc")]
    public DateTime IssuedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "revoked_at_utc", IsNullable = true)]
    public DateTime? RevokedAtUtc { get; set; }

    [SugarColumn(ColumnName = "metadata_json", ColumnDataType = "text")]
    public string MetadataJson { get; set; } = "{}";
}

public static class AnonymousCredentialTypes
{
    public const string AccountBound = "account_bound";
    public const string ZkCommitment = "zk_commitment";
}

public static class AnonymousCredentialLevels
{
    public const string Basic = "basic";
    public const string Trusted = "trusted";
    public const string StrongAnonymous = "strong_anonymous";
}

public static class AnonymousCredentialStatuses
{
    public const string Active = "active";
    public const string Revoked = "revoked";
}
