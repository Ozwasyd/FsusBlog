using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_moderation_signal")]
[SugarIndex("idx_comment_moderation_signal_comment_id", nameof(CommentId), OrderByType.Asc)]
[SugarIndex("idx_comment_moderation_signal_provider_time", nameof(Provider), OrderByType.Asc, nameof(CreatedAtUtc), OrderByType.Desc)]
[SugarIndex("idx_comment_moderation_signal_label_confidence", nameof(Label), OrderByType.Asc, nameof(Confidence), OrderByType.Desc)]
[SugarIndex("idx_comment_moderation_signal_second_round", nameof(NeedsSecondRound), OrderByType.Asc, nameof(CreatedAtUtc), OrderByType.Desc)]
public sealed class CommentModerationSignal
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId { get; set; }

    [SugarColumn(ColumnName = "provider", Length = 64)]
    public string Provider { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "model", Length = 128)]
    public string Model { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "contract_version", Length = 64)]
    public string ContractVersion { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "label", Length = 64)]
    public string Label { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "severity", Length = 32)]
    public string Severity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "confidence")]
    public double Confidence { get; set; }

    [SugarColumn(ColumnName = "primary_reason", Length = 128, IsNullable = true)]
    public string? PrimaryReason { get; set; }

    [SugarColumn(ColumnName = "needs_second_round")]
    public bool NeedsSecondRound { get; set; }

    [SugarColumn(ColumnName = "risk_categories", ColumnDataType = "text", IsNullable = true)]
    public string? RiskCategories { get; set; }

    [SugarColumn(ColumnName = "evidence_json", ColumnDataType = "text", IsNullable = true)]
    public string? EvidenceJson { get; set; }

    [SugarColumn(ColumnName = "raw_reason", ColumnDataType = "text", IsNullable = true)]
    public string? RawReason { get; set; }

    [SugarColumn(ColumnName = "latency_ms")]
    public int LatencyMs { get; set; }

    [SugarColumn(ColumnName = "status", Length = 32)]
    public string Status { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "error_code", Length = 64, IsNullable = true)]
    public string? ErrorCode { get; set; }

    [SugarColumn(ColumnName = "threshold_profile", Length = 128, IsNullable = true)]
    public string? ThresholdProfile { get; set; }

    [SugarColumn(ColumnName = "metadata_json", ColumnDataType = "text", IsNullable = true)]
    public string? MetadataJson { get; set; }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}
