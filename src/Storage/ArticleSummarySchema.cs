using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string ArticleRevisionColumns = "article_revision article_id:int4 revision:int8 title:text body:text happened_at:timestamptz";
    private const string ArticleSummaryConstraint = "article_revision c author_summary char_length(author_summary)>=1ANDchar_length(author_summary)<=512";

    private const string ArticleRevisionRelation = "public.article_revision";

    internal static Task<bool> HasArticleSummaryAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct) =>
        HasColumnAndCheckAsync(connection, transaction, ct, ArticleRevisionRelation, "author_summary",
            "article_revision_author_summary_length", "The article author summary schema is incomplete.");

    private static bool HasArticleSummary(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumnAndCheck(ArticleRevisionRelation, "author_summary",
            "article_revision_author_summary_length", "The article author summary schema is incomplete.");
}
