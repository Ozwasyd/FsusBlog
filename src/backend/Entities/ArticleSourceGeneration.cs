using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// The single durable article mutation family clock. Its row is serialized until the
/// original mutation transaction commits; it is neither an index nor baseline authority.
/// </summary>
[SugarTable("article_source_generation")]
public sealed class ArticleSourceGeneration
{
    [SugarColumn(ColumnName = "family_id", IsPrimaryKey = true)]
    public int FamilyId { get; set; } = 1;

    [SugarColumn(ColumnName = "source_generation")]
    public long SourceGeneration
    {
        get; set;
    }
}

/// <summary>Durable local article sequence; portable identity remains with its original owner.</summary>
[SugarTable("article_source_sequence")]
public sealed class ArticleSourceSequence
{
    [SugarColumn(ColumnName = "article_id", IsPrimaryKey = true)]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "source_sequence")]
    public long SourceSequence
    {
        get; set;
    }
}
