using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// Enrollment of an actual outbox event. Immutable facts exclude delivery/claim state;
/// the journal preserves the original allocation on retries and rejects altered facts.
/// </summary>
[SugarTable("article_source_mutation")]
[SugarIndex("ux_article_source_mutation_generation", nameof(SourceGeneration), OrderByType.Asc, true)]
[SugarIndex("ux_article_source_mutation_sequence", nameof(ArticleId), OrderByType.Asc,
    nameof(SourceSequence), OrderByType.Asc, true)]
public sealed class ArticleSourceMutation
{
    [SugarColumn(ColumnName = "event_id", Length = 36, IsPrimaryKey = true)]
    public string EventId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source_generation")]
    public long SourceGeneration
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source_sequence")]
    public long SourceSequence
    {
        get; set;
    }

    [SugarColumn(ColumnName = "event_facts", ColumnDataType = "text")]
    public string EventFacts { get; set; } = string.Empty;
}
