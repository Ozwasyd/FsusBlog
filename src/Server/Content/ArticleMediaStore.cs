using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal static class ArticleMediaStore
{
    internal const int Maximum = 32;

    internal static async Task<List<Guid>> Read(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision, CancellationToken ct)
    {
        await using var command = SqlCommands.Create(db, tx, """
            SELECT asset_id FROM public.article_revision_media WHERE article_id=$1 AND revision=$2 ORDER BY asset_id LIMIT 33
            """, article, revision);
        await using var rows = await command.ExecuteReaderAsync(ct);
        List<Guid> assets = [];
        while (await rows.ReadAsync(ct)) assets.Add(rows.GetGuid(0));
        if (assets.Count > Maximum) throw new InvalidOperationException("Private attachment list exceeds its allowed size.");
        return assets;
    }

    internal static async Task Copy(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int article, long source,
        long revision, ArticleMediaCommand? change, CancellationToken ct, ArticleCoverCommand? cover = null)
    {
        if (change is null)
        {
            await using var copy = SqlCommands.Create(db, tx, """
                INSERT INTO public.article_revision_media(article_id,revision,asset_id)
                SELECT article_id,$3,asset_id FROM public.article_revision_media WHERE article_id=$1 AND revision=$2
                """, article, source, revision);
            if (await copy.ExecuteNonQueryAsync(ct) > 0 || cover is not null)
                await CopyCover(db, tx, article, source, revision, cover, ct);
            return;
        }

        var assets = await Read(db, tx, article, source, ct);
        if (change.Attach)
        {
            if (assets.Count >= Maximum || assets.Contains(change.AssetId))
                throw new BusinessException(Rejection.Conflict, "This asset is already attached or the attachment limit was reached.");
            await using var available = SqlCommands.Create(db, tx, """
                SELECT id FROM public.private_media WHERE id=$1 AND owner_id=$2 AND phase=1 FOR UPDATE
                """, change.AssetId, owner);
            if (await available.ExecuteScalarAsync(ct) is null) throw Missing();
            assets.Add(change.AssetId);
        }
        else if (!assets.Remove(change.AssetId)) throw Missing();

        if (assets.Count == 0) return;
        await using var insert = SqlCommands.Create(db, tx, """
            INSERT INTO public.article_revision_media (article_id,revision,asset_id)
            SELECT $1,$2,asset FROM pg_catalog.unnest($3) AS refs(asset)
            """, article, revision, assets.ToArray());
        await insert.ExecuteNonQueryAsync(ct);
        await CopyCover(db, tx, article, source, revision, cover, ct);
    }

    private static async Task CopyCover(NpgsqlConnection db, NpgsqlTransaction tx, int article, long source,
        long revision, ArticleCoverCommand? change, CancellationToken ct)
    {
        if (change is { AssetId: var value } && value == Guid.Empty) return;
        if (change is null && !await CurrentSchema.HasArticleCoverAsync(db, tx, ct)) return;

        // Join the copied attachment so removing it also clears the cover on that successor alone.
        var selection = change is null
            ? "(select asset_id from public.article_revision_cover where article_id=$1 and revision=$3)"
            : "$3";
        await using var copy = SqlCommands.Create(db, tx, $"""
            INSERT INTO public.article_revision_cover(article_id,revision,asset_id)
            SELECT article_id,revision,asset_id FROM public.article_revision_media
            WHERE article_id=$1 AND revision=$2 AND asset_id={selection}
            """, article, revision, (object?)change?.AssetId ?? source);
        if (await copy.ExecuteNonQueryAsync(ct) != 1 && change is not null) throw Missing();
    }

    internal static async Task WriteCoverHeaders(NpgsqlConnection db, NpgsqlTransaction tx, HttpResponse response,
        int article, long current, CancellationToken ct, long? source = null)
    {
        if (!await CurrentSchema.HasArticleCoverAsync(db, tx, ct)) return;
        await using var command = SqlCommands.Create(db, tx, """
            SELECT revision,asset_id FROM public.article_revision_cover
            WHERE article_id=$1 AND revision IN ($2,$3)
            """, article, current, source ?? current);
        await using var rows = await command.ExecuteReaderAsync(ct);
        response.Headers[WireHeaders.ArticleCover] = "none";
        if (source is not null) response.Headers[WireHeaders.SourceArticleCover] = "none";
        while (await rows.ReadAsync(ct))
            response.Headers[rows.GetInt64(0) == current ? WireHeaders.ArticleCover : WireHeaders.SourceArticleCover] =
                rows.GetGuid(1).ToString("D");
    }

    internal static async Task<bool> Contains(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, int article,
        long revision, Guid asset, CancellationToken ct)
    {
        await using var query = SqlCommands.Create(db, tx, """
            SELECT a.id FROM public.article a JOIN public.article_revision_media r
              ON r.article_id=a.id AND r.revision=a.revision
            WHERE a.owner_id=$1 AND a.id=$2 AND a.revision=$3 AND NOT a.deleted AND r.asset_id=$4 FOR SHARE OF a
            """, owner, article, revision, asset);
        return await query.ExecuteScalarAsync(ct) is not null &&
            !await ArchivedArticleAuthority.IsLockedArchived(db, tx, article, ct);
    }

    internal static async Task EnsureUnreferenced(NpgsqlConnection db, NpgsqlTransaction tx, Guid asset, CancellationToken ct)
    {
        await using var query = SqlCommands.Create(db, tx, "SELECT EXISTS (SELECT FROM public.article_revision_media WHERE asset_id=$1)", asset);
        if (await query.ExecuteScalarAsync(ct) is true)
            throw new BusinessException(Rejection.Conflict, "A retained article revision references this private asset.");
    }

    internal static BusinessException Missing() => new(Rejection.NotFound, "Private article attachment not found.");
}
