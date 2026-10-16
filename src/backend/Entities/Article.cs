using FsusBlog.Contracts.Articles;

using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_tag")]
[SugarIndex("idx_article_tag_article_tag", nameof(ArticleId), OrderByType.Asc, nameof(TagId), OrderByType.Asc, true)]
[SugarIndex("idx_article_tag_tag_article", nameof(TagId), OrderByType.Asc, nameof(ArticleId), OrderByType.Asc)]
public class ArticleTag
{
    [SugarColumn(IsPrimaryKey = true)] // 联合主键 part 1
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(IsPrimaryKey = true)] // 联合主键 part 2
    public int TagId
    {
        get; set;
    }
}

/// <summary>
/// 文章
/// </summary>
[SugarTable("article")]
[SugarIndex("idx_article_deleted_time", nameof(IsDeleted), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
[SugarIndex("idx_article_category_deleted_time", nameof(CategoryId), OrderByType.Asc, nameof(IsDeleted), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
[SugarIndex("idx_article_public_status_time", nameof(IsDeleted), OrderByType.Asc, nameof(Status), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
[SugarIndex("idx_article_public_category_status_time", nameof(CategoryId), OrderByType.Asc, nameof(IsDeleted), OrderByType.Asc, nameof(Status), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
public class Article
{
    // PostgreSQL 自增主键
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public int Id
    {
        get; set;
    }

    [SugarColumn(Length = 256)]
    public string Title { get; set; } = null!;

    // 摘要
    [SugarColumn(Length = 512, IsNullable = true)]
    public string? Summary
    {
        get; set;
    }

    // 头图
    [SugarColumn(Length = 512, IsNullable = true)]
    public string? CoverImageUrl
    {
        get; set;
    }

    // 1. 分类 (多对一: Article -> Category)
    public int CategoryId
    {
        get; set;
    }

    // 导航属性: 不映射到数据库字段，查询时自动填充
    [SugarColumn(IsIgnore = true)]
    [Navigate(NavigateType.OneToOne, nameof(CategoryId))]
    public Category? Category
    {
        get; set;
    }

    // 2. 标签 (多对多: Article <-> Tag)
    // 导航属性: 通过中间表 ArticleTag 关联
    [SugarColumn(IsIgnore = true)]
    [Navigate(typeof(ArticleTag), nameof(ArticleTag.ArticleId), nameof(ArticleTag.TagId))]
    public List<Tag> Tags { get; set; } = null!;

    // 正文从独立表加载；保留该属性只用于聚合读模型和搜索索引编译，不参与 article 元表持久化。
    [SugarColumn(IsIgnore = true)]
    public string Content { get; set; } = string.Empty;

    public int Views { get; set; } = ArticleCurrentPolicyDefaults.InitialLiveViews;

    public DateTime CreateTime { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// Last substantive change to article metadata (title, summary, cover, taxonomy, or lifecycle state).
    /// Body changes continue to use <see cref="ArticleBody.UpdatedAt"/>.
    /// </summary>
    [SugarColumn(ColumnName = "metadata_updated_at")]
    public DateTime MetadataUpdatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "status")]
    public ArticleStatus Status { get; set; } = (ArticleStatus)ArticleCurrentPolicyDefaults.Status;

    [SugarColumn(ColumnName = "scheduled_publish_at", IsNullable = true)]
    public DateTime? ScheduledPublishAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "published_at", IsNullable = true)]
    public DateTime? PublishedAt
    {
        get; set;
    }

    /// <summary>
    /// Most recent real publication or republication. Unlike <see cref="PublishedAt"/>, this value advances.
    /// </summary>
    [SugarColumn(ColumnName = "last_published_at", IsNullable = true)]
    public DateTime? LastPublishedAt
    {
        get; set;
    }

    /// <summary>
    /// Last substantive change visible through the current public revision/publication.
    /// </summary>
    [SugarColumn(ColumnName = "public_updated_at", IsNullable = true)]
    public DateTime? PublicUpdatedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "current_revision_id", IsNullable = true)]
    public long? CurrentRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "current_publication_id", IsNullable = true)]
    public long? CurrentPublicationId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "pending_publication_at", IsNullable = true)]
    public DateTime? PendingPublicationAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "archived_at", IsNullable = true)]
    public DateTime? ArchivedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "deleted_at", IsNullable = true)]
    public DateTime? DeletedAt
    {
        get; set;
    }

    // 逻辑删除
    [SugarColumn(IsNullable = false, DefaultValue = "false")]
    public bool IsDeleted
    {
        get; set;
    }

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }
}

public enum ArticleStatus
{
    Draft = 0,
    Scheduled = 1,
    Published = 2,
    Archived = 3,
    Deleted = 4
}

public static class ArticlePublication
{
    public static bool IsPubliclyVisible(Article article, DateTime utcNow)
        => IsPubliclyVisible(
            article.Status,
            article.IsDeleted,
            article.PublishedAt,
            article.ScheduledPublishAt,
            utcNow);

    public static bool IsPubliclyVisible(
        ArticleStatus status,
        bool isDeleted,
        DateTime? publishedAt,
        DateTime? scheduledPublishAt,
        DateTime utcNow)
        => !isDeleted
            && status == ArticleStatus.Published
            && (!publishedAt.HasValue || publishedAt.Value <= utcNow)
            && (!scheduledPublishAt.HasValue || scheduledPublishAt.Value <= utcNow);
}

[SugarTable("article_body")]
public class ArticleBody
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_draft")]
[SugarIndex("idx_article_draft_admin_principal_key", nameof(OwnerAdminPrincipalId), OrderByType.Asc, nameof(DraftKey), OrderByType.Asc, true)]
public class ArticleDraft
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "owner_admin_principal_id")]
    public long OwnerAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id", IsNullable = true)]
    public int? ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "base_revision_id", IsNullable = true)]
    public long? BaseRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "draft_key", Length = 96)]
    public string DraftKey { get; set; } = string.Empty;

    [SugarColumn(Length = 256)]
    public string Title { get; set; } = string.Empty;

    [SugarColumn(Length = 512, IsNullable = true)]
    public string? Summary
    {
        get; set;
    }

    [SugarColumn(ColumnName = "cover_image_url", Length = 512, IsNullable = true)]
    public string? CoverImageUrl
    {
        get; set;
    }

    public int CategoryId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "tag_ids", ColumnDataType = "text")]
    public string TagIds { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "status")]
    public ArticleStatus Status { get; set; } = ArticleStatus.Published;

    [SugarColumn(ColumnName = "scheduled_publish_at", IsNullable = true)]
    public DateTime? ScheduledPublishAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_json", ColumnDataType = "text", IsNullable = true)]
    public string? RightsJson
    {
        get; set;
    }

    [SugarColumn(ColumnName = "client_revision", Length = 64, IsNullable = true)]
    public string? ClientRevision
    {
        get; set;
    }

    [SugarColumn(ColumnName = "server_revision")]
    public long ServerRevision { get; set; } = 1;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_revision")]
[SugarIndex("idx_article_revision_article_time", nameof(ArticleId), OrderByType.Asc, nameof(CreatedAt), OrderByType.Desc)]
[SugarIndex("ux_article_revision_article_revision_no", nameof(ArticleId), OrderByType.Asc, nameof(RevisionNo), OrderByType.Asc, true)]
public class ArticleRevision
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(Length = 256)]
    public string Title { get; set; } = string.Empty;

    [SugarColumn(Length = 512, IsNullable = true)]
    public string? Summary
    {
        get; set;
    }

    [SugarColumn(ColumnName = "cover_image_url", Length = 512, IsNullable = true)]
    public string? CoverImageUrl
    {
        get; set;
    }

    public int CategoryId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "tag_ids", ColumnDataType = "text")]
    public string TagIds { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_block_id")]
    public long ContentBlockId
    {
        get; set;
    }

    // Expand/contract compatibility only. New writes leave this empty; migration clears
    // historical values after content_block_id has been verified reachable.
    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "diff_summary", Length = 512)]
    public string DiffSummary { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_by_admin_principal_id")]
    public long CreatedByAdminPrincipalId
    {
        get; set;
    } = ArticleCurrentPolicyDefaults.UnattributedCreatorId;

    [SugarColumn(ColumnName = "rollback_source_revision_id", IsNullable = true)]
    public long? RollbackSourceRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rollback_reason", Length = 500, IsNullable = true)]
    public string? RollbackReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_revision_content_block")]
[SugarIndex("ux_article_revision_content_block_hash", nameof(ContentHash), OrderByType.Asc, true)]
public class ArticleRevisionContentBlock
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "content_hash", Length = 64)]
    public string ContentHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "byte_length")]
    public int ByteLength
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// Immutable record of one public article publication. Public projections resolve content and
/// attached policy snapshots through this record instead of guessing the newest authoring row.
/// </summary>
[SugarTable("article_publication")]
[SugarIndex("ux_article_publication_article_no", nameof(ArticleId), OrderByType.Asc, nameof(PublicationNo), OrderByType.Asc, true)]
[SugarIndex("idx_article_publication_revision", nameof(ArticleRevisionId), OrderByType.Asc)]
public class ArticlePublicationRecord
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "publication_no")]
    public int PublicationNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_revision_id")]
    public long ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_snapshot_id")]
    public long RightsSnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "responsibility_snapshot_id", IsNullable = true)]
    public long? ResponsibilitySnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "transition_kind", Length = 32)]
    public string TransitionKind { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "published_at")]
    public DateTime PublishedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// 文章级责任、来源与修订说明的不可变快照。公开读取按 article revision 解析，
/// 不携带后台 actor、草稿正文或审核内部字段。
/// </summary>
[SugarTable("article_responsibility_snapshot")]
[SugarIndex("ux_article_responsibility_revision_version", nameof(ArticleRevisionId), OrderByType.Asc, nameof(ResponsibilityVersion), OrderByType.Asc, true)]
[SugarIndex("idx_article_responsibility_article_revision", nameof(ArticleId), OrderByType.Asc, nameof(ArticleRevisionId), OrderByType.Asc, nameof(ResponsibilityVersion), OrderByType.Desc)]
public class ArticleResponsibilitySnapshot
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_revision_id")]
    public long ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "responsibility_version")]
    public int ResponsibilityVersion { get; set; } = ArticleCurrentPolicyDefaults.ResponsibilityVersion;

    [SugarColumn(ColumnName = "previous_snapshot_id", IsNullable = true)]
    public long? PreviousSnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "inherit_site_author")]
    public bool InheritSiteAuthor { get; set; } = ArticleCurrentPolicyDefaults.InheritSiteAuthor;

    [SugarColumn(ColumnName = "authors_json", ColumnDataType = "text")]
    public string AuthorsJson { get; set; } = ArticleCurrentPolicyDefaults.EmptyPeopleJson;

    [SugarColumn(ColumnName = "reviewer_json", ColumnDataType = "text", IsNullable = true)]
    public string? ReviewerJson
    {
        get; set;
    }

    [SugarColumn(ColumnName = "sources_json", ColumnDataType = "text")]
    public string SourcesJson { get; set; } = ArticleCurrentPolicyDefaults.EmptyPeopleJson;

    [SugarColumn(ColumnName = "update_summary", Length = 512, IsNullable = true)]
    public string? UpdateSummary
    {
        get; set;
    }

    [SugarColumn(ColumnName = "update_reason", Length = 512, IsNullable = true)]
    public string? UpdateReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "effective_at", IsNullable = true)]
    public DateTime? EffectiveAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "conclusion_impact", Length = 32, IsNullable = true)]
    public string? ConclusionImpact
    {
        get; set;
    }

    [SugarColumn(ColumnName = "methodology", ColumnDataType = "text", IsNullable = true)]
    public string? Methodology
    {
        get; set;
    }

    [SugarColumn(ColumnName = "applicability", ColumnDataType = "text", IsNullable = true)]
    public string? Applicability
    {
        get; set;
    }

    [SugarColumn(ColumnName = "limitations", ColumnDataType = "text", IsNullable = true)]
    public string? Limitations
    {
        get; set;
    }

    [SugarColumn(ColumnName = "responsible_person_confirmed")]
    public bool ResponsiblePersonConfirmed
    {
        get; set;
    } = ArticleCurrentPolicyDefaults.ResponsiblePersonConfirmed;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_rights_policy")]
[SugarIndex("ux_article_rights_policy_article", nameof(ArticleId), OrderByType.Asc, true)]
public class ArticleRightsPolicy
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "enabled", IsNullable = false, DefaultValue = "true")]
    public bool Enabled { get; set; } = true;

    [SugarColumn(ColumnName = "license_type", Length = 48)]
    public string LicenseType { get; set; } = "all-rights-reserved";

    [SugarColumn(ColumnName = "copyright_holder", Length = 256, IsNullable = true)]
    public string? CopyrightHolder
    {
        get; set;
    }

    [SugarColumn(ColumnName = "copyright_year", IsNullable = true)]
    public int? CopyrightYear
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_statement", ColumnDataType = "text", IsNullable = true)]
    public string? RightsStatement
    {
        get; set;
    }

    [SugarColumn(ColumnName = "attribution_template", ColumnDataType = "text", IsNullable = true)]
    public string? AttributionTemplate
    {
        get; set;
    }

    [SugarColumn(ColumnName = "copy_policy", Length = 48)]
    public string CopyPolicy { get; set; } = "append-attribution";

    [SugarColumn(ColumnName = "max_excerpt_chars")]
    public int MaxExcerptChars { get; set; } = 300;

    [SugarColumn(ColumnName = "allow_code_copy", IsNullable = false, DefaultValue = "true")]
    public bool AllowCodeCopy { get; set; } = true;

    [SugarColumn(ColumnName = "show_public_badge", IsNullable = false, DefaultValue = "true")]
    public bool ShowPublicBadge { get; set; } = true;

    [SugarColumn(ColumnName = "proof_binding_enabled", IsNullable = false, DefaultValue = "true")]
    public bool ProofBindingEnabled { get; set; } = true;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_rights_snapshot")]
[SugarIndex("ux_article_rights_snapshot_article_revision", nameof(ArticleId), OrderByType.Asc, nameof(ArticleRevisionId), OrderByType.Asc, true)]
[SugarIndex("idx_article_rights_snapshot_policy", nameof(ArticleRightsPolicyId), OrderByType.Asc)]
[SugarIndex("idx_article_rights_snapshot_hash", nameof(PolicyHash), OrderByType.Asc)]
public class ArticleRightsSnapshot
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_revision_id")]
    public long ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_rights_policy_id")]
    public long ArticleRightsPolicyId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "enabled", IsNullable = false, DefaultValue = "true")]
    public bool Enabled { get; set; } = true;

    [SugarColumn(ColumnName = "license_type", Length = 48)]
    public string LicenseType { get; set; } = "all-rights-reserved";

    [SugarColumn(ColumnName = "copyright_holder", Length = 256, IsNullable = true)]
    public string? CopyrightHolder
    {
        get; set;
    }

    [SugarColumn(ColumnName = "copyright_year", IsNullable = true)]
    public int? CopyrightYear
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_statement", ColumnDataType = "text", IsNullable = true)]
    public string? RightsStatement
    {
        get; set;
    }

    [SugarColumn(ColumnName = "attribution_template", ColumnDataType = "text", IsNullable = true)]
    public string? AttributionTemplate
    {
        get; set;
    }

    [SugarColumn(ColumnName = "copy_policy", Length = 48)]
    public string CopyPolicy { get; set; } = "append-attribution";

    [SugarColumn(ColumnName = "max_excerpt_chars")]
    public int MaxExcerptChars { get; set; } = 300;

    [SugarColumn(ColumnName = "allow_code_copy", IsNullable = false, DefaultValue = "true")]
    public bool AllowCodeCopy { get; set; } = true;

    [SugarColumn(ColumnName = "show_public_badge", IsNullable = false, DefaultValue = "true")]
    public bool ShowPublicBadge { get; set; } = true;

    [SugarColumn(ColumnName = "proof_binding_enabled", IsNullable = false, DefaultValue = "true")]
    public bool ProofBindingEnabled { get; set; } = true;

    [SugarColumn(ColumnName = "canonical_url", Length = 512, IsNullable = true)]
    public string? CanonicalUrl
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_hash", Length = 96)]
    public string PolicyHash { get; set; } = "rights-v3:policy-hash:recompute";

    [SugarColumn(ColumnName = "content_canonical_hash", Length = 96)]
    public string ContentCanonicalHash { get; set; } = "rights-v3:content-hash:recompute";

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_rights_proof")]
[SugarIndex("ux_article_rights_proof_idempotency", nameof(IdempotencyKey), OrderByType.Asc, true)]
[SugarIndex("idx_article_rights_proof_article_revision", nameof(ArticleId), OrderByType.Asc, nameof(ArticleRevisionId), OrderByType.Asc)]
[SugarIndex("idx_article_rights_proof_snapshot", nameof(ArticleRightsSnapshotId), OrderByType.Asc)]
[SugarIndex("idx_article_rights_proof_status_time", nameof(ProofStatus), OrderByType.Asc, nameof(CreatedAt), OrderByType.Desc)]
public class ArticleRightsProof
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "proof_version")]
    public int ProofVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "signature_payload_version")]
    public int SignaturePayloadVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_revision_id")]
    public long ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_rights_snapshot_id")]
    public long ArticleRightsSnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "publish_proof_id", IsNullable = true)]
    public long? PublishProofId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "idempotency_key", Length = 160)]
    public string IdempotencyKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "rights_policy_hash", Length = 96)]
    public string RightsPolicyHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_canonical_hash", Length = 96)]
    public string ContentCanonicalHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "proof_status", Length = 24)]
    public string ProofStatus { get; set; } = "pending";

    [SugarColumn(ColumnName = "signing_key_id", Length = 128, IsNullable = true)]
    public string? SigningKeyId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signing_key_version", IsNullable = true)]
    public int? SigningKeyVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signing_algorithm", Length = 32, IsNullable = true)]
    public string? SigningAlgorithm
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signature", Length = 256, IsNullable = true)]
    public string? SignatureBase64Url
    {
        get; set;
    }

    [SugarColumn(ColumnName = "failure_code", Length = 64, IsNullable = true)]
    public string? FailureCode
    {
        get; set;
    }

    [SugarColumn(ColumnName = "failure_detail", Length = 512, IsNullable = true)]
    public string? FailureDetail
    {
        get; set;
    }

    [SugarColumn(ColumnName = "transparency_log_entry_id", IsNullable = true)]
    public long? TransparencyLogEntryId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "transparency_log_entry_hash", Length = 64, IsNullable = true)]
    public string? TransparencyLogEntryHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_publish_proof")]
[SugarIndex("ux_article_publish_proof_idempotency", nameof(IdempotencyKey), OrderByType.Asc, true)]
[SugarIndex("idx_article_publish_proof_article_revision", nameof(ArticleId), OrderByType.Asc, nameof(ArticleRevisionId), OrderByType.Asc)]
[SugarIndex("idx_article_publish_proof_status_time", nameof(ProofStatus), OrderByType.Asc, nameof(PublishedAt), OrderByType.Desc)]
public class ArticlePublishProof
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "proof_version")]
    public int ProofVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "signature_payload_version")]
    public int SignaturePayloadVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_revision_id")]
    public long ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "idempotency_key", Length = 128)]
    public string IdempotencyKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "canonical_hash", Length = 71)]
    public string CanonicalHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "aot_hash", Length = 71)]
    public string AotHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "article_detail_aeds_hash", Length = 71)]
    public string ArticleDetailAedsHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "public_hot_read_hash", Length = 71)]
    public string PublicHotReadHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "asset_manifest_hash", Length = 71)]
    public string AssetManifestHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "feed_hash", Length = 71)]
    public string FeedHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "published_at")]
    public DateTime PublishedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "proof_status", Length = 24)]
    public string ProofStatus { get; set; } = "pending";

    [SugarColumn(ColumnName = "signing_key_id", Length = 128, IsNullable = true)]
    public string? SigningKeyId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signing_key_version", IsNullable = true)]
    public int? SigningKeyVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signing_algorithm", Length = 32, IsNullable = true)]
    public string? SigningAlgorithm
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signature", Length = 256, IsNullable = true)]
    public string? SignatureBase64Url
    {
        get; set;
    }

    [SugarColumn(ColumnName = "failure_code", Length = 64, IsNullable = true)]
    public string? FailureCode
    {
        get; set;
    }

    [SugarColumn(ColumnName = "failure_detail", Length = 512, IsNullable = true)]
    public string? FailureDetail
    {
        get; set;
    }

    [SugarColumn(ColumnName = "transparency_log_entry_id", IsNullable = true)]
    public long? TransparencyLogEntryId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "transparency_log_entry_hash", Length = 64, IsNullable = true)]
    public string? TransparencyLogEntryHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "superseded_at", IsNullable = true)]
    public DateTime? SupersededAt
    {
        get; set;
    }
}

[SugarTable("integrity_transparency_log")]
[SugarIndex("ux_integrity_transparency_log_seq", nameof(Seq), OrderByType.Asc, true)]
[SugarIndex("ux_integrity_transparency_log_entry_hash", nameof(EntryHash), OrderByType.Asc, true)]
[SugarIndex("ux_integrity_transparency_log_proof_entry", nameof(EntryType), OrderByType.Asc, nameof(ProofId), OrderByType.Asc, true)]
[SugarIndex("idx_integrity_transparency_log_article_revision", nameof(ArticleId), OrderByType.Asc, nameof(ArticleRevisionId), OrderByType.Asc)]
[SugarIndex("idx_integrity_transparency_log_created_at", nameof(CreatedAt), OrderByType.Desc)]
public class IntegrityTransparencyLogEntry
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "seq")]
    public long Seq
    {
        get; set;
    }

    [SugarColumn(ColumnName = "entry_type", Length = 32)]
    public string EntryType { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "proof_id", IsNullable = true)]
    public long? ProofId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id", IsNullable = true)]
    public int? ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_revision_id", IsNullable = true)]
    public long? ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no", IsNullable = true)]
    public int? RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "entry_payload_hash", Length = 64)]
    public string EntryPayloadHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "prev_entry_hash", Length = 64)]
    public string PrevEntryHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "entry_hash", Length = 64)]
    public string EntryHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "signing_key_id", Length = 128, IsNullable = true)]
    public string? SigningKeyId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "signature", Length = 256, IsNullable = true)]
    public string? SignatureBase64Url
    {
        get; set;
    }
}

[SugarTable("integrity_merkle_checkpoint")]
[SugarIndex("ux_integrity_merkle_checkpoint_kind_scope", nameof(CheckpointKind), OrderByType.Asc, nameof(ScopeKey), OrderByType.Asc, true)]
[SugarIndex("idx_integrity_merkle_checkpoint_log_head", nameof(LogHeadSeq), OrderByType.Desc, nameof(LogHeadHash), OrderByType.Asc)]
[SugarIndex("idx_integrity_merkle_checkpoint_root_hash", nameof(RootHash), OrderByType.Asc)]
[SugarIndex("idx_integrity_merkle_checkpoint_created_at", nameof(CreatedAt), OrderByType.Desc)]
public class IntegrityMerkleCheckpoint
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "checkpoint_kind", Length = 24)]
    public string CheckpointKind { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "scope_key", Length = 64)]
    public string ScopeKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "from_seq")]
    public long FromSeq
    {
        get; set;
    }

    [SugarColumn(ColumnName = "to_seq")]
    public long ToSeq
    {
        get; set;
    }

    [SugarColumn(ColumnName = "entry_count")]
    public int EntryCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "root_hash", Length = 64)]
    public string RootHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "log_head_seq")]
    public long LogHeadSeq
    {
        get; set;
    }

    [SugarColumn(ColumnName = "log_head_hash", Length = 64)]
    public string LogHeadHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "manifest_hash", Length = 64)]
    public string ManifestHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "manifest_json", ColumnDataType = "text")]
    public string ManifestJson { get; set; } = "{}";

    [SugarColumn(ColumnName = "signing_key_id", Length = 128)]
    public string SigningKeyId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "signing_algorithm", Length = 32)]
    public string SigningAlgorithm { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "signature", Length = 256)]
    public string SignatureBase64Url { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_mutation_outbox")]
[SugarIndex("ux_article_mutation_outbox_event_id", nameof(EventId), OrderByType.Asc, true)]
[SugarIndex("idx_article_mutation_outbox_pending", nameof(Status), OrderByType.Asc, nameof(NextRetryAt), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
[SugarIndex("idx_article_mutation_outbox_claim", nameof(Status), OrderByType.Asc, nameof(ClaimExpiresAt), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
[SugarIndex(
    "idx_article_mutation_outbox_version_coordinate",
    nameof(AggregateId),
    OrderByType.Asc,
    nameof(ArticlePublicationId),
    OrderByType.Asc,
    nameof(ArticleRevisionId),
    OrderByType.Asc,
    nameof(Id),
    OrderByType.Asc)]
public class ArticleMutationOutboxEvent
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "event_id", Length = 36)]
    public string EventId { get; set; } = Guid.NewGuid().ToString("N");

    [SugarColumn(ColumnName = "aggregate_type", Length = 32)]
    public string AggregateType { get; set; } = "article";

    [SugarColumn(ColumnName = "aggregate_id")]
    public int AggregateId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "schema_version")]
    public int SchemaVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "article_revision_id", IsNullable = true)]
    public long? ArticleRevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_no", IsNullable = true)]
    public int? RevisionNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rights_snapshot_id", IsNullable = true)]
    public long? RightsSnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "responsibility_snapshot_id", IsNullable = true)]
    public long? ResponsibilitySnapshotId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "responsibility_version", IsNullable = true)]
    public int? ResponsibilityVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_publication_id", IsNullable = true)]
    public long? ArticlePublicationId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "publication_no", IsNullable = true)]
    public int? PublicationNo
    {
        get; set;
    }

    [SugarColumn(ColumnName = "event_type", Length = 64)]
    public string EventType { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "payload_json", ColumnDataType = "text")]
    public string PayloadJson { get; set; } = "{}";

    [SugarColumn(ColumnName = "status", Length = 24)]
    public string Status { get; set; } = "pending";

    [SugarColumn(ColumnName = "retry_count")]
    public int RetryCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "next_retry_at")]
    public DateTime NextRetryAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "processed_at", IsNullable = true)]
    public DateTime? ProcessedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_error", Length = 1024, IsNullable = true)]
    public string? LastError
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claim_token", Length = 64, IsNullable = true)]
    public string? ClaimToken
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claimed_by", Length = 128, IsNullable = true)]
    public string? ClaimedBy
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claimed_at", IsNullable = true)]
    public DateTime? ClaimedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "heartbeat_at", IsNullable = true)]
    public DateTime? HeartbeatAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claim_expires_at", IsNullable = true)]
    public DateTime? ClaimExpiresAt
    {
        get; set;
    }
}

[SugarTable("article_mutation_outbox_edge")]
[SugarIndex(
    "ux_article_mutation_outbox_edge_event_name",
    nameof(OutboxEventId),
    OrderByType.Asc,
    nameof(EdgeName),
    OrderByType.Asc,
    true)]
[SugarIndex("idx_article_mutation_outbox_edge_status", nameof(Status), OrderByType.Asc, nameof(UpdatedAt), OrderByType.Desc)]
public class ArticleMutationOutboxEdge
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "outbox_event_id")]
    public long OutboxEventId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "edge_name", Length = 64)]
    public string EdgeName { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "status", Length = 24)]
    public string Status { get; set; } = ArticleMutationOutboxEdgeStatus.Pending;

    [SugarColumn(ColumnName = "attempt_count")]
    public int AttemptCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_error", Length = 1024, IsNullable = true)]
    public string? LastError
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "delivery_key", Length = 64, IsNullable = true)]
    public string? DeliveryKey
    {
        get; set;
    }
}

public static class ArticleMutationOutboxEdgeStatus
{
    public const string Pending = "pending";
    public const string Completed = "completed";
    public const string Failed = "failed";
    public const string Skipped = "skipped";
}

[SugarTable("site_subscription")]
[SugarIndex("idx_site_subscription_email", nameof(EmailHash), OrderByType.Asc, true)]
public class SiteSubscription
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "email_hash", Length = 64)]
    public string EmailHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "hash_version", Length = 16)]
    public string HashVersion { get; set; } = "hmac-v1";

    [SugarColumn(ColumnName = "channel", Length = 32)]
    public string Channel { get; set; } = "rss";

    [SugarColumn(ColumnName = "is_enabled")]
    public bool IsEnabled { get; set; } = true;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "unsubscribed_at", IsNullable = true)]
    public DateTime? UnsubscribedAt
    {
        get; set;
    }
}
