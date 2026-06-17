using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_anonymous_nullifier")]
[SugarIndex("unique_idx_comment_nullifier_scope", nameof(NullifierHash), OrderByType.Asc, nameof(Scope), OrderByType.Asc, true)]
[SugarIndex("idx_comment_nullifier_blocked", nameof(Blocked), OrderByType.Asc)]
public sealed class CommentAnonymousNullifier
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "nullifier_hash", Length = 128)]
    public string NullifierHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "scope", Length = 128)]
    public string Scope { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "use_count")]
    public int UseCount { get; set; }

    [SugarColumn(ColumnName = "first_comment_id", IsNullable = true)]
    public long? FirstCommentId { get; set; }

    [SugarColumn(ColumnName = "last_comment_id", IsNullable = true)]
    public long? LastCommentId { get; set; }

    [SugarColumn(ColumnName = "blocked")]
    public bool Blocked { get; set; }

    [SugarColumn(ColumnName = "block_reason", Length = 256, IsNullable = true)]
    public string? BlockReason { get; set; }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

public sealed record NullifierReservationResult(
    bool Allowed,
    string Status,
    string Message,
    int CurrentUseCount);
