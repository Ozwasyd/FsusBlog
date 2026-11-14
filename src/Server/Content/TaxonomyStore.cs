using FsusBlog.V2.Contracts;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed record TaxonomyRows(
    IReadOnlyList<TaxonomyMetadata> Categories,
    IReadOnlyList<TaxonomyMetadata> Tags,
    IReadOnlyList<(string NameKey, int TagId)> Aliases);

internal static class TaxonomyStore
{
    internal static async Task<TaxonomyRows> Read(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            select id,name,description from public.category order by id;
            select id,name,description from public.tag order by id;
            select name_key,tag_id from public.tag_url_name order by name_key;
            """);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        var categories = await Metadata(reader, ct);
        await reader.NextResultAsync(ct);
        var tags = await Metadata(reader, ct);
        await reader.NextResultAsync(ct);
        var aliases = new List<(string, int)>();
        while (await reader.ReadAsync(ct))
            aliases.Add((reader.GetString(0), reader.GetInt32(1)));
        return new(categories, tags, aliases);
    }

    internal static async Task CarryForward(NpgsqlConnection db, NpgsqlTransaction tx, int articleId, long sourceRevision,
        long nextRevision, CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            with category_copied as (
                insert into public.article_revision_category(article_id,revision,category_id)
                select article_id,$3,category_id from public.article_revision_category where article_id=$1 and revision=$2
            )
            insert into public.article_revision_tag(article_id,revision,tag_id)
            select article_id,$3,tag_id from public.article_revision_tag where article_id=$1 and revision=$2
            """, articleId, sourceRevision, nextRevision);
        await cmd.ExecuteNonQueryAsync(ct);
    }

    private static async Task<List<TaxonomyMetadata>> Metadata(NpgsqlDataReader reader, CancellationToken ct)
    {
        var items = new List<TaxonomyMetadata>();
        while (await reader.ReadAsync(ct))
            items.Add(new(reader.GetInt32(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2)));
        return items;
    }
}
