using FsusBlog.Contracts.Schema;

using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// The single durable article mutation family clock. Its row is serialized until the
/// original mutation transaction commits; it is neither an index nor baseline authority.
/// </summary>
[SugarTable("article_source_generation")]
[CurrentSchemaConstraint("ck_article_source_generation_family", "check", nameof(FamilyId), Expression = "family_id = 1")]
[CurrentSchemaConstraint("ck_article_source_generation_positive", "check", nameof(SourceGeneration), Expression = "source_generation > 0")]
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
[CurrentSchemaConstraint("ck_article_source_sequence_article", "check", nameof(ArticleId), Expression = "article_id > 0")]
[CurrentSchemaConstraint("ck_article_source_sequence_positive", "check", nameof(SourceSequence), Expression = "source_sequence > 0")]
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
