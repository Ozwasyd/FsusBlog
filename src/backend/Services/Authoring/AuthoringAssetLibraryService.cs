using System.Data.Common;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Articles;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Read projection over the canonical asset and reference ledgers. This
/// service never scans article Markdown and never owns schema creation.
/// </summary>
public sealed class AuthoringAssetLibraryService(ISqlSugarClient db) : IAuthoringAssetQuery, IAuthoringAssetCommands
{
    private readonly PublicAssetUrlCodec _urlCodec = new();

    public async Task<IReadOnlyList<AssetLibraryItemResponse>> ReindexAssetsAsync(
        int articleId,
        CancellationToken cancellationToken = default)
    {
        _ = await db.Queryable<Article>()
            .ClearFilter()
            .Where(article => article.Id == articleId)
            .AnyAsync(cancellationToken);
        return await ListAssetsAsync(cancellationToken).ConfigureAwait(false);
    }

    public async Task<AssetCleanupResponse> CleanupOrphanAssetsAsync(CancellationToken cancellationToken = default)
    {
        DateTime now = DateTime.UtcNow;
        int scheduled = await db.Ado.ExecuteCommandAsync(
            """
            WITH orphan AS (
                SELECT asset.id AS asset_id
                FROM content_asset asset
                WHERE NOT EXISTS (
                    SELECT 1 FROM content_asset_reference reference
                    WHERE reference.asset_id = asset.id
                )
                FOR UPDATE
            ), queued AS (
                INSERT INTO content_asset_cleanup_queue(
                    asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
                SELECT asset_id, @NotBeforeUtc, 0, NULL, @UpdatedAtUtc
                FROM orphan
                ON CONFLICT (asset_id) DO UPDATE
                SET not_before_utc = LEAST(content_asset_cleanup_queue.not_before_utc, EXCLUDED.not_before_utc),
                    last_error = NULL,
                    updated_at_utc = EXCLUDED.updated_at_utc
                RETURNING asset_id
            )
            UPDATE content_asset asset
            SET state = 'pending_delete', updated_at_utc = @UpdatedAtUtc
            FROM queued
            WHERE asset.id = queued.asset_id;
            """,
            new SugarParameter("@NotBeforeUtc", now + ArticleAssetReferenceStore.CleanupDelay),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
        return new AssetCleanupResponse(scheduled);
    }

    public async Task<IReadOnlyList<AssetLibraryItemResponse>> ListAssetsAsync(
        CancellationToken cancellationToken = default)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                asset.id,
                asset.storage_key,
                asset.sha256,
                asset.updated_at_utc,
                MIN(reference.article_id) AS source_article_id,
                MAX(reference.alt_text) FILTER (
                    WHERE reference.alt_text IS NOT NULL AND reference.alt_text <> ''
                ) AS alt_text,
                COALESCE(SUM(reference.reference_count), 0)::integer AS reference_count
            FROM content_asset asset
            LEFT JOIN content_asset_reference reference
                ON reference.asset_id = asset.id
            GROUP BY asset.id, asset.storage_key, asset.sha256, asset.updated_at_utc
            ORDER BY asset.updated_at_utc DESC, asset.id
            LIMIT 100;
            """);
        var result = new List<AssetLibraryItemResponse>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            AssetStorageKey storageKey = AssetStorageKey.Parse(reader.ReadString("storage_key"));
            result.Add(new AssetLibraryItemResponse(
                reader.GetGuid(reader.GetOrdinal("id")).ToString("D"),
                _urlCodec.ToPublicPath(storageKey),
                reader.IsNull("alt_text") ? null : reader.ReadString("alt_text"),
                reader.IsNull("source_article_id") ? null : reader.ReadInt32("source_article_id"),
                reader.ReadInt32("reference_count"),
                reader.IsNull("sha256") ? null : reader.ReadString("sha256"),
                reader.ReadDateTime("updated_at_utc")));
        }

        return result;
    }
}
