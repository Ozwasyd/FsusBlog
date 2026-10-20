using FsusBlog.Contracts.Schema;

using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// Same-family enrollment of an original persisted definition, policy or value observation.
/// A family observation without an article is not an invented article event or baseline.
/// </summary>
[SugarTable("article_source_observation")]
[SugarIndex("ux_article_source_observation_generation", nameof(SourceGeneration), OrderByType.Asc, true)]
[SugarIndex("ux_article_source_observation_sequence", nameof(ArticleId), OrderByType.Asc,
    nameof(SourceSequence), OrderByType.Asc, true)]
[CurrentSchemaConstraint("ck_article_source_observation_origin", "check", nameof(OriginKind), nameof(OriginKey), nameof(OriginFacts),
    Expression = "origin_kind IN ('article', 'property-definition', 'security-policy', 'property-value', 'taxonomy', 'display-locale') AND length(origin_key) > 0 AND length(origin_facts) > 0")]
[CurrentSchemaConstraint("ck_article_source_observation_coordinates", "check", nameof(SourceGeneration), nameof(ArticleId), nameof(SourceSequence),
    Expression = "source_generation > 0 AND ((article_id IS NULL AND source_sequence IS NULL) OR (article_id IS NOT NULL AND source_sequence IS NOT NULL AND article_id > 0 AND source_sequence > 0 AND source_sequence <= source_generation))")]
public sealed class ArticleSourceObservation
{
    [SugarColumn(ColumnName = "origin_kind", Length = 32, IsPrimaryKey = true)]
    public string OriginKind { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "origin_key", Length = 160, IsPrimaryKey = true)]
    public string OriginKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "source_generation")]
    public long SourceGeneration
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id", IsNullable = true)]
    public int? ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source_sequence", IsNullable = true)]
    public long? SourceSequence
    {
        get; set;
    }

    [SugarColumn(ColumnName = "origin_facts", ColumnDataType = "text")]
    public string OriginFacts { get; set; } = string.Empty;
}
