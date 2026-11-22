using FsusBlogV2.Storage;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal sealed record TaxonomyRows(
    IReadOnlyList<TaxonomyMetadata> Categories,
    IReadOnlyList<TaxonomyMetadata> Tags,
    IReadOnlyList<(string NameKey, int TagId)> Aliases);

internal static class TaxonomyStore
{
    internal static async Task<DraftTaxonomy> ReadDraft(NpgsqlConnection db, NpgsqlTransaction tx, int articleId,
        long revision, CancellationToken ct)
    {
        await using var cmd = SqlCommands.Create(db, tx, """
            select coalesce((select category_id from public.article_revision_category where article_id=$1 and revision=$2),0),
                   array(select tag_id from public.article_revision_tag where article_id=$1 and revision=$2 order by tag_id)
            """, articleId, revision);
        await using var reader = await cmd.ExecuteReaderAsync(ct);
        await reader.ReadRequired(ct, () => new InvalidOperationException("Draft taxonomy query returned no row."));
        return new(articleId, revision, reader.GetInt32(0), reader.GetFieldValue<int[]>(1));
    }

    internal static async Task Replace(NpgsqlConnection db, NpgsqlTransaction tx, int articleId, long revision,
        int category, IReadOnlyList<int> tags, CancellationToken ct)
    {
        await using var cmd = SqlCommands.Create(db, tx, """
            with category_link as (
                insert into public.article_revision_category(article_id,revision,category_id)
                select $1,$2,$3 where $3<>0
            )
            insert into public.article_revision_tag(article_id,revision,tag_id)
            select $1,$2,requested.id from unnest($4::integer[]) as requested(id)
            """, articleId, revision, category, tags.ToArray());
        try { await cmd.ExecuteNonQueryAsync(ct); }
        catch (PostgresException error) when (error.SqlState == PostgresErrorCodes.ForeignKeyViolation &&
            error.ConstraintName is "article_revision_category_category_id_fkey" or "article_revision_tag_tag_id_fkey")
        {
            throw new BusinessException(Rejection.Invalid, "A selected category or tag no longer exists.");
        }
    }

    internal static async Task<TaxonomyRows> Read(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var cmd = SqlCommands.Create(db, tx, """
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
        await SqlCommands.Execute(db, tx, ct, """
            with category_copied as (
                insert into public.article_revision_category(article_id,revision,category_id)
                select article_id,$3,category_id from public.article_revision_category where article_id=$1 and revision=$2
            )
            insert into public.article_revision_tag(article_id,revision,tag_id)
            select article_id,$3,tag_id from public.article_revision_tag where article_id=$1 and revision=$2
            """, articleId, sourceRevision, nextRevision);
    }

    private static async Task<List<TaxonomyMetadata>> Metadata(NpgsqlDataReader reader, CancellationToken ct)
    {
        var items = new List<TaxonomyMetadata>();
        while (await reader.ReadAsync(ct))
            items.Add(new(reader.GetInt32(0), reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2)));
        return items;
    }
}
