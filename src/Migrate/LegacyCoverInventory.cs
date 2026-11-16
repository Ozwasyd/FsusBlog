using System.Data.Common;

internal static partial class Migration
{
    private sealed record LegacyCoverInventory(long ArticleRows, long RevisionRows,
        long CurrentEditRows, long CurrentPublicationRows, long OtherRevisionRows);

    private static async Task<LegacyCoverInventory> ReadLegacyCoverInventoryAsync(LegacySource source,
        DbTransaction transaction, Dictionary<string, LegacyTable> tables, CancellationToken token)
    {
        string T(string table) => source.Table(tables[table]);
        string F(string table, string column) => source.Field(tables[table], column);
        var articleRows = await CountAsync($"FROM {T(Article)} WHERE TRIM({F(Article, "coverimageurl")}) <> ''",
            transaction, token);

        var id = $"r.{F(Revision, "id")}";
        var edit = $"a.{F(Article, "current_revision_id")}";
        var published = $"p.{F(Publication, "article_revision_id")}";
        await using var command = CreateLegacyCommand(transaction, $"""
            SELECT COUNT(*), COUNT(*) FILTER (WHERE {id} = {edit}),
                COUNT(*) FILTER (WHERE {id} = {published}),
                COUNT(*) FILTER (WHERE {id} IS DISTINCT FROM {edit} AND {id} IS DISTINCT FROM {published})
            FROM {T(Revision)} r
            JOIN {T(Article)} a ON a.{F(Article, "id")} = r.{F(Revision, "article_id")}
            LEFT JOIN {T(Publication)} p ON p.{F(Publication, "id")} = a.{F(Article, "current_publication_id")}
                AND p.{F(Publication, "article_id")} = a.{F(Article, "id")}
            WHERE TRIM(r.{F(Revision, "cover_image_url")}) <> ''
            """);
        await using var rows = await command.ExecuteReaderAsync(token);
        if (!await rows.ReadAsync(token)) throw new InvalidOperationException("Missing legacy cover counts.");
        return new(articleRows, rows.GetInt64(0), rows.GetInt64(1), rows.GetInt64(2), rows.GetInt64(3));
    }
}
