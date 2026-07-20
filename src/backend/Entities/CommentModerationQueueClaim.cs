using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_moderation_queue_claim")]
[SugarIndex("idx_comment_moderation_claim_lease", nameof(State), OrderByType.Asc, nameof(LeaseExpiresAtUtc), OrderByType.Asc, nameof(CommentId), OrderByType.Asc)]
[SugarIndex("idx_comment_moderation_claim_owner", nameof(OwnerAdminPrincipalId), OrderByType.Asc, nameof(State), OrderByType.Asc, nameof(LeaseExpiresAtUtc), OrderByType.Asc)]
public sealed class CommentModerationQueueClaim
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "owner_admin_principal_id")]
    public long OwnerAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claim_token_hash", Length = 64)]
    public string ClaimTokenHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "state", Length = 16)]
    public string State { get; set; } = CommentModerationClaimStates.Active;

    [SugarColumn(ColumnName = "claimed_at_utc")]
    public DateTime ClaimedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lease_expires_at_utc")]
    public DateTime LeaseExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "renewed_at_utc", IsNullable = true)]
    public DateTime? RenewedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "released_at_utc", IsNullable = true)]
    public DateTime? ReleasedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "process_sla_due_at_utc")]
    public DateTime ProcessSlaDueAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "note", Length = 1000, IsNullable = true)]
    public string? Note
    {
        get; set;
    }

    [SugarColumn(ColumnName = "escalation_status", Length = 24)]
    public string EscalationStatus { get; set; } = CommentModerationEscalationStatuses.None;

    [SugarColumn(ColumnName = "claim_generation")]
    public int ClaimGeneration
    {
        get; set;
    }

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }
}

public static class CommentModerationClaimStates
{
    public const string Active = "active";
    public const string Released = "released";
    public const string Completed = "completed";
    public const string Expired = "expired";
}

public static class CommentModerationEscalationStatuses
{
    public const string None = "none";
    public const string Watch = "watch";
    public const string Escalated = "escalated";

    public static bool IsAllowed(string? value)
        => value is None or Watch or Escalated;
}
