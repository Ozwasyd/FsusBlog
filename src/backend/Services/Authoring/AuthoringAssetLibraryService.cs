using System.Data.Common;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

public sealed class AuthoringAssetLibraryService(ISqlSugarClient db) : IAuthoringAssetQuery, IAuthoringAssetCommands
{
    private static int s_assetArticleReferenceStoreEnsured;
    public async Task<IReadOnlyList<AssetLibraryItemResponse>> ReindexAssetsAsync(int articleId, CancellationToken cancellationToken = default)
    {
        bool articleExists = await db.Queryable<Article>()
            .ClearFilter()
            .Where(it => it.Id == articleId)
            .AnyAsync(cancellationToken);
        if (!articleExists)
        {
            return await ListAssetsAsync(cancellationToken);
        }

        await ReindexArticleAssetsAsync(articleId, cancellationToken);
        return await ListAssetsAsync(cancellationToken);
    }

    public async Task<AssetCleanupResponse> CleanupOrphanAssetsAsync(CancellationToken cancellationToken = default)
    {
        int deleted = await db.Deleteable<AssetLibraryItem>()
            .Where(it => it.ReferenceCount <= 0)
            .ExecuteCommandAsync(cancellationToken);
        return new AssetCleanupResponse(deleted);
    }

    public async Task<IReadOnlyList<AssetLibraryItemResponse>> ListAssetsAsync(CancellationToken cancellationToken = default)
        => (await db.Queryable<AssetLibraryItem>()
            .OrderByDescending(it => it.UpdatedAt)
            .Take(100)
            .ToListAsync(cancellationToken))
            .Select(ToAssetResponse)
            .ToArray();

    private async Task ReindexArticleAssetsAsync(int articleId, CancellationToken cancellationToken)
    {
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await AcquireAssetLibraryRebuildLockAsync(cancellationToken).ConfigureAwait(false);
            await EnsureAssetArticleReferenceStoreAsync(cancellationToken).ConfigureAwait(false);
            DateTime now = DateTime.UtcNow;

            Article? article = await db.Queryable<Article>()
                .ClearFilter()
                .Where(it => it.Id == articleId)
                .FirstAsync(cancellationToken);
            string markdown = await db.Queryable<ArticleBody>()
                .Where(it => it.ArticleId == articleId)
                .Select(it => it.MarkdownContent)
                .FirstAsync(cancellationToken) ?? string.Empty;

            Dictionary<string, AssetReferenceAggregate> currentAssets = BuildArticleAssetReferences(articleId, markdown, article?.CoverImageUrl);
            List<AssetArticleReferenceRow> previousRefs = await LoadArticleAssetReferencesForUpdateAsync(articleId, cancellationToken)
                .ConfigureAwait(false);
            HashSet<string> touchedUrls = new(StringComparer.OrdinalIgnoreCase);
            foreach (string url in currentAssets.Keys)
            {
                touchedUrls.Add(url);
            }

            foreach (AssetArticleReferenceRow previous in previousRefs)
            {
                touchedUrls.Add(previous.Url);
                if (!currentAssets.ContainsKey(previous.Url))
                {
                    await DeleteAssetArticleReferenceAsync(articleId, previous.Url, cancellationToken).ConfigureAwait(false);
                }
            }

            foreach (AssetReferenceAggregate asset in currentAssets.Values)
            {
                await UpsertAssetArticleReferenceAsync(asset, now, cancellationToken).ConfigureAwait(false);
            }

            await RefreshAssetLibraryItemsForUrlsAsync(touchedUrls, now, cancellationToken).ConfigureAwait(false);
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Article asset reindex failed.", transaction.ErrorException);
        }
    }

    private async Task RebuildAssetLibraryAsync(CancellationToken cancellationToken)
    {
        await EnsureAssetArticleReferenceStoreAsync(cancellationToken).ConfigureAwait(false);
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await AcquireAssetLibraryRebuildLockAsync(cancellationToken);
            DateTime now = DateTime.UtcNow;
            List<ArticleBody> bodies = await db.Queryable<ArticleBody>().ToListAsync(cancellationToken);
            List<int> articleIds = [.. bodies.Select(static body => body.ArticleId).Distinct()];
            List<Article> articles = articleIds.Count == 0
                ? []
                : await db.Queryable<Article>()
                    .ClearFilter()
                    .Where(it => articleIds.Contains(it.Id))
                    .ToListAsync(cancellationToken);
            Dictionary<int, Article> articleById = articles.ToDictionary(static article => article.Id);
            var assets = new Dictionary<string, AssetReferenceAggregate>(StringComparer.OrdinalIgnoreCase);
            var articleAssetReferences = new List<AssetReferenceAggregate>();

            foreach (ArticleBody body in bodies)
            {
                articleById.TryGetValue(body.ArticleId, out Article? article);
                Dictionary<string, AssetReferenceAggregate> articleAssets = BuildArticleAssetReferences(body.ArticleId, body.MarkdownContent, article?.CoverImageUrl);
                foreach (AssetReferenceAggregate articleAsset in articleAssets.Values)
                {
                    articleAssetReferences.Add(articleAsset);
                    MergeAssetReference(assets, articleAsset);
                }
            }

            List<AssetLibraryItem> existingAssets = await LoadAssetLibraryForUpdateAsync(cancellationToken);
            Dictionary<string, AssetLibraryItem> existingAssetsByUrl = existingAssets
                .GroupBy(static item => item.Url, StringComparer.OrdinalIgnoreCase)
                .ToDictionary(static group => group.Key, static group => group.First(), StringComparer.OrdinalIgnoreCase);
            HashSet<string> activeUrls = [.. assets.Keys];
            await db.Ado.ExecuteCommandAsync("DELETE FROM asset_library_article_ref;").ConfigureAwait(false);
            foreach (AssetReferenceAggregate articleAsset in articleAssetReferences)
            {
                await UpsertAssetArticleReferenceAsync(articleAsset, now, cancellationToken).ConfigureAwait(false);
            }

            foreach (AssetReferenceAggregate asset in assets.Values)
            {
                existingAssetsByUrl.TryGetValue(asset.Url, out AssetLibraryItem? existing);
                if (existing is null)
                {
                    await InsertAssetAsync(asset, now, cancellationToken);
                    continue;
                }

                await UpdateAssetAsync(existing, asset, now, cancellationToken);
            }

            foreach (AssetLibraryItem orphan in existingAssets.Where(item => !activeUrls.Contains(item.Url) && item.ReferenceCount != 0))
            {
                await MarkAssetOrphanAsync(orphan.Id, now, cancellationToken);
            }
        });

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException("Asset library rebuild failed.", transaction.ErrorException);
        }
    }

    private async Task AcquireAssetLibraryRebuildLockAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            "SELECT pg_advisory_xact_lock(785);");
        await reader.ReadAsync(cancellationToken);
    }

    private async Task<List<AssetLibraryItem>> LoadAssetLibraryForUpdateAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, url, alt_text, source_article_id, width, height, sha256, reference_count, created_at, updated_at
            FROM asset_library_item
            ORDER BY id
            FOR UPDATE;
            """);
        var assets = new List<AssetLibraryItem>();
        while (await reader.ReadAsync(cancellationToken))
        {
            assets.Add(new AssetLibraryItem
            {
                Id = reader.ReadInt64("id"),
                Url = reader.ReadString("url"),
                AltText = reader.IsNull("alt_text") ? null : reader.ReadString("alt_text"),
                SourceArticleId = reader.IsNull("source_article_id") ? null : reader.ReadInt32("source_article_id"),
                Width = reader.IsNull("width") ? null : reader.ReadInt32("width"),
                Height = reader.IsNull("height") ? null : reader.ReadInt32("height"),
                Sha256 = reader.IsNull("sha256") ? null : reader.ReadString("sha256"),
                ReferenceCount = reader.ReadInt32("reference_count"),
                CreatedAt = reader.ReadDateTime("created_at"),
                UpdatedAt = reader.ReadDateTime("updated_at")
            });
        }

        return assets;
    }

    private async Task EnsureAssetArticleReferenceStoreAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref s_assetArticleReferenceStoreEnsured) == 1)
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync("""
            CREATE TABLE IF NOT EXISTS asset_library_article_ref (
                url varchar(512) NOT NULL,
                article_id integer NOT NULL,
                alt_text varchar(256) NULL,
                reference_count integer NOT NULL DEFAULT 0,
                updated_at_utc timestamp NOT NULL DEFAULT (now() AT TIME ZONE 'utc'),
                PRIMARY KEY (url, article_id)
            );

            CREATE INDEX IF NOT EXISTS idx_asset_library_article_ref_article
            ON asset_library_article_ref(article_id);
            """).ConfigureAwait(false);
        Volatile.Write(ref s_assetArticleReferenceStoreEnsured, 1);
    }

    private async Task<List<AssetArticleReferenceRow>> LoadArticleAssetReferencesForUpdateAsync(int articleId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT url, article_id, alt_text, reference_count
            FROM asset_library_article_ref
            WHERE article_id = @ArticleId
            FOR UPDATE;
            """,
            new SugarParameter("@ArticleId", articleId));
        var rows = new List<AssetArticleReferenceRow>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            rows.Add(new AssetArticleReferenceRow(
                reader.ReadString("url"),
                reader.ReadInt32("article_id"),
                reader.IsNull("alt_text") ? null : reader.ReadString("alt_text"),
                reader.ReadInt32("reference_count")));
        }

        return rows;
    }

    private async Task UpsertAssetArticleReferenceAsync(AssetReferenceAggregate asset, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO asset_library_article_ref
                (url, article_id, alt_text, reference_count, updated_at_utc)
            VALUES
                (@Url, @ArticleId, @AltText, @ReferenceCount, @UpdatedAtUtc)
            ON CONFLICT (url, article_id) DO UPDATE
            SET alt_text = EXCLUDED.alt_text,
                reference_count = EXCLUDED.reference_count,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@Url", asset.Url),
            new SugarParameter("@ArticleId", asset.SourceArticleId),
            new SugarParameter("@AltText", AuthoringNormalization.DbValue(asset.AltText)),
            new SugarParameter("@ReferenceCount", asset.ReferenceCount),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
    }

    private async Task DeleteAssetArticleReferenceAsync(int articleId, string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM asset_library_article_ref
            WHERE article_id = @ArticleId
              AND lower(url) = lower(@Url);
            """,
            new SugarParameter("@ArticleId", articleId),
            new SugarParameter("@Url", url)).ConfigureAwait(false);
    }

    private async Task RefreshAssetLibraryItemsForUrlsAsync(IReadOnlyCollection<string> urls, DateTime now, CancellationToken cancellationToken)
    {
        foreach (string url in urls)
        {
            cancellationToken.ThrowIfCancellationRequested();
            AssetReferenceAggregate? aggregate = await LoadAssetReferenceAggregateAsync(url, cancellationToken).ConfigureAwait(false);
            if (aggregate is null)
            {
                await MarkAssetOrphanByUrlAsync(url, now, cancellationToken).ConfigureAwait(false);
                continue;
            }

            AssetLibraryItem? existing = await LoadAssetLibraryItemByUrlForUpdateAsync(url, cancellationToken).ConfigureAwait(false);
            if (existing is null)
            {
                await InsertAssetAsync(aggregate, now, cancellationToken).ConfigureAwait(false);
                continue;
            }

            await UpdateAssetAsync(existing, aggregate, now, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<AssetReferenceAggregate?> LoadAssetReferenceAggregateAsync(string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                url,
                MIN(article_id) AS source_article_id,
                MAX(alt_text) FILTER (WHERE alt_text IS NOT NULL AND alt_text <> '') AS alt_text,
                SUM(reference_count)::integer AS reference_count
            FROM asset_library_article_ref
            WHERE lower(url) = lower(@Url)
            GROUP BY url;
            """,
            new SugarParameter("@Url", url));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        var aggregate = new AssetReferenceAggregate(reader.ReadString("url"), reader.ReadInt32("source_article_id"))
        {
            AltText = reader.IsNull("alt_text") ? null : reader.ReadString("alt_text"),
            ReferenceCount = reader.ReadInt32("reference_count")
        };
        return aggregate;
    }

    private async Task<AssetLibraryItem?> LoadAssetLibraryItemByUrlForUpdateAsync(string url, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, url, alt_text, source_article_id, width, height, sha256, reference_count, created_at, updated_at
            FROM asset_library_item
            WHERE lower(url) = lower(@Url)
            ORDER BY id
            LIMIT 1
            FOR UPDATE;
            """,
            new SugarParameter("@Url", url));
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            return null;
        }

        return new AssetLibraryItem
        {
            Id = reader.ReadInt64("id"),
            Url = reader.ReadString("url"),
            AltText = reader.IsNull("alt_text") ? null : reader.ReadString("alt_text"),
            SourceArticleId = reader.IsNull("source_article_id") ? null : reader.ReadInt32("source_article_id"),
            Width = reader.IsNull("width") ? null : reader.ReadInt32("width"),
            Height = reader.IsNull("height") ? null : reader.ReadInt32("height"),
            Sha256 = reader.IsNull("sha256") ? null : reader.ReadString("sha256"),
            ReferenceCount = reader.ReadInt32("reference_count"),
            CreatedAt = reader.ReadDateTime("created_at"),
            UpdatedAt = reader.ReadDateTime("updated_at")
        };
    }

    private async Task InsertAssetAsync(AssetReferenceAggregate asset, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO asset_library_item
                (url, alt_text, source_article_id, sha256, reference_count, created_at, updated_at)
            VALUES
                (@Url, @AltText, @SourceArticleId, @Sha256, @ReferenceCount, @Now, @Now);
            """,
            new SugarParameter("@Url", asset.Url),
            new SugarParameter("@AltText", AuthoringNormalization.DbValue(asset.AltText)),
            new SugarParameter("@SourceArticleId", asset.SourceArticleId),
            new SugarParameter("@Sha256", AuthoringNormalization.HashText(asset.Url)),
            new SugarParameter("@ReferenceCount", asset.ReferenceCount),
            new SugarParameter("@Now", now));
    }

    private async Task UpdateAssetAsync(AssetLibraryItem existing, AssetReferenceAggregate asset, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE asset_library_item
            SET alt_text = COALESCE(@AltText, alt_text),
                source_article_id = COALESCE(source_article_id, @SourceArticleId),
                sha256 = COALESCE(sha256, @Sha256),
                reference_count = @ReferenceCount,
                updated_at = @UpdatedAt
            WHERE id = @Id;
            """,
            new SugarParameter("@Id", existing.Id),
            new SugarParameter("@AltText", AuthoringNormalization.DbValue(asset.AltText)),
            new SugarParameter("@SourceArticleId", asset.SourceArticleId),
            new SugarParameter("@Sha256", AuthoringNormalization.HashText(asset.Url)),
            new SugarParameter("@ReferenceCount", asset.ReferenceCount),
            new SugarParameter("@UpdatedAt", now));
    }

    private async Task MarkAssetOrphanAsync(long assetId, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE asset_library_item
            SET reference_count = 0,
                updated_at = @UpdatedAt
            WHERE id = @Id
              AND reference_count <> 0;
            """,
            new SugarParameter("@Id", assetId),
            new SugarParameter("@UpdatedAt", now));
    }

    private async Task MarkAssetOrphanByUrlAsync(string url, DateTime now, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE asset_library_item
            SET reference_count = 0,
                updated_at = @UpdatedAt
            WHERE lower(url) = lower(@Url)
              AND reference_count <> 0;
            """,
            new SugarParameter("@Url", url),
            new SugarParameter("@UpdatedAt", now)).ConfigureAwait(false);
    }


    private static AssetLibraryItemResponse ToAssetResponse(AssetLibraryItem item)
        => new(item.Id.ToString(CultureInfo.InvariantCulture), item.Url, item.AltText, item.SourceArticleId, item.ReferenceCount, item.Sha256, item.UpdatedAt);


    private static void AddAssetReference(Dictionary<string, AssetReferenceAggregate> assets, string url, string? altText, int articleId)
    {
        if (!ArticleAssetUrlNormalizer.TryNormalize(url, out string normalizedUrl))
        {
            return;
        }

        if (!assets.TryGetValue(normalizedUrl, out AssetReferenceAggregate? aggregate))
        {
            aggregate = new AssetReferenceAggregate(normalizedUrl, articleId);
            assets[normalizedUrl] = aggregate;
        }

        aggregate.ReferenceCount++;
        if (string.IsNullOrWhiteSpace(aggregate.AltText) && !string.IsNullOrWhiteSpace(altText))
        {
            aggregate.AltText = TextHelpers.NormalizeNullable(altText, 256);
        }
    }

    private static Dictionary<string, AssetReferenceAggregate> BuildArticleAssetReferences(int articleId, string markdownContent, string? coverImageUrl)
    {
        var assets = new Dictionary<string, AssetReferenceAggregate>(StringComparer.OrdinalIgnoreCase);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent))
        {
            AddAssetReference(assets, reference.Url, reference.AltText, articleId);
        }

        AddAssetReference(assets, coverImageUrl ?? string.Empty, null, articleId);

        return assets;
    }

    private static void MergeAssetReference(Dictionary<string, AssetReferenceAggregate> assets, AssetReferenceAggregate source)
    {
        if (!assets.TryGetValue(source.Url, out AssetReferenceAggregate? aggregate))
        {
            aggregate = new AssetReferenceAggregate(source.Url, source.SourceArticleId);
            assets[source.Url] = aggregate;
        }

        aggregate.ReferenceCount += source.ReferenceCount;
        if (string.IsNullOrWhiteSpace(aggregate.AltText) && !string.IsNullOrWhiteSpace(source.AltText))
        {
            aggregate.AltText = source.AltText;
        }
    }

    private sealed class AssetReferenceAggregate(string url, int sourceArticleId)
    {
        public string Url { get; } = url;
        public string? AltText
        {
            get; set;
        }
        public int SourceArticleId { get; } = sourceArticleId;
        public int ReferenceCount
        {
            get; set;
        }
    }

    private sealed record AssetArticleReferenceRow(
        string Url,
        int ArticleId,
        string? AltText,
        int ReferenceCount);

}
