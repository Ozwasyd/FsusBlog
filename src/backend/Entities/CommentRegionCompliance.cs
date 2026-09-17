using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_region_compliance")]
[SugarIndex("idx_comment_region_compliance_comment", nameof(CommentId), OrderByType.Asc)]
[SugarIndex("idx_comment_region_compliance_submit_region", nameof(SubmitRegion), OrderByType.Asc, nameof(CreatedAtUtc), OrderByType.Desc)]
[SugarIndex("idx_comment_region_compliance_policy", nameof(PolicyVersion), OrderByType.Asc, nameof(CreatedAtUtc), OrderByType.Desc)]
public sealed class CommentRegionCompliance
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "submit_region", Length = 64)]
    public string SubmitRegion { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "submit_region_confidence")]
    public double SubmitRegionConfidence
    {
        get; set;
    }

    [SugarColumn(ColumnName = "region_provider", Length = 64)]
    public string RegionProvider { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "submit_ip_hash", Length = 64, IsNullable = true)]
    public string? SubmitIpHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_version", Length = 64)]
    public string PolicyVersion { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "can_publish")]
    public bool CanPublish
    {
        get; set;
    }

    [SugarColumn(ColumnName = "requires_manual_review")]
    public bool RequiresManualReview
    {
        get; set;
    }

    [SugarColumn(ColumnName = "hide_until_reviewed")]
    public bool HideUntilReviewed
    {
        get; set;
    }

    [SugarColumn(ColumnName = "blocked_regions", ColumnDataType = "text")]
    public string BlockedRegions { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "risk_labels", ColumnDataType = "text")]
    public string RiskLabels { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "decision_reason", Length = 256, IsNullable = true)]
    public string? DecisionReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rule_hits_json", ColumnDataType = "text", IsNullable = true)]
    public string? RuleHitsJson
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
