using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>One durable portable identity per real article; existence grants no access.</summary>
[SugarTable("article_relation_article_binding")]
[SugarIndex("ux_article_relation_article_identity", nameof(PortableIdentity), OrderByType.Asc, true)]
public sealed class ArticleRelationArticleBinding
{
    [SugarColumn(ColumnName = "article_id", IsPrimaryKey = true)]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "portable_identity")]
    public Guid PortableIdentity
    {
        get; set;
    }
}

/// <summary>
/// Immutable coordinates for one actual immutable revision. Current and published are views
/// of this same source incarnation; drafts and editor runtime epochs are outside this mapping.
/// </summary>
[SugarTable("article_relation_source_coordinate")]
[SugarIndex("ux_article_relation_revision_identity", nameof(RevisionIdentity), OrderByType.Asc, true)]
[SugarIndex("ux_article_relation_source_epoch", nameof(SourceEpoch), OrderByType.Asc, true)]
public sealed class ArticleRelationSourceCoordinate
{
    [SugarColumn(ColumnName = "revision_id", IsPrimaryKey = true)]
    public long RevisionId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revision_identity")]
    public Guid RevisionIdentity
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source_epoch")]
    public Guid SourceEpoch
    {
        get; set;
    }
}
