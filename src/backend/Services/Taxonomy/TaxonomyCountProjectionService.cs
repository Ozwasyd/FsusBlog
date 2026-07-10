using System.Diagnostics;
using System.Globalization;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;
using SqlSugar;

namespace FsusBlog.Server.Services.Taxonomy;

public interface ITaxonomyCountProjectionService
{
    Task ReconcileArticleAsync(int articleId, CancellationToken cancellationToken = default);
    Task<long> BumpFrameVersionAsync(string reason, CancellationToken cancellationToken = default);
}

public sealed class TaxonomyCountProjectionService(
    ISqlSugarClient db,
    IUnifiedCache cache,
    IHttpCacheInvalidator httpCacheInvalidator) : ITaxonomyCountProjectionService
{
    public async Task ReconcileArticleAsync(int articleId, CancellationToken cancellationToken = default)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        ArticlePublicTaxonomyProjection? previous = await db.Queryable<ArticlePublicTaxonomyProjection>()
            .Where(it => it.ArticleId == articleId)
            .FirstAsync();
        CurrentPublicTaxonomy current = await LoadCurrentAsync(articleId);

        int updatedRows = 0;
        int? previousCategoryId = previous?.CategoryId;
        if (previousCategoryId != current.CategoryId)
        {
            if (previousCategoryId is > 0)
            {
                await ApplyCategoryDeltaAsync(previousCategoryId.Value, -1).ConfigureAwait(false);
                updatedRows++;
            }

            if (current.CategoryId is > 0)
            {
                await ApplyCategoryDeltaAsync(current.CategoryId.Value, 1).ConfigureAwait(false);
                updatedRows++;
            }
        }

        HashSet<int> previousTagIds = ParseTagIds(previous?.TagIds);
        HashSet<int> currentTagIds = current.TagIds.ToHashSet();
        foreach (int tagId in previousTagIds.Except(currentTagIds))
        {
            await ApplyTagDeltaAsync(tagId, -1).ConfigureAwait(false);
            updatedRows++;
        }

        foreach (int tagId in currentTagIds.Except(previousTagIds))
        {
            await ApplyTagDeltaAsync(tagId, 1).ConfigureAwait(false);
            updatedRows++;
        }

        if (current.CategoryId is null && currentTagIds.Count == 0)
        {
            await db.Deleteable<ArticlePublicTaxonomyProjection>()
                .Where(it => it.ArticleId == articleId)
                .ExecuteCommandAsync()
                .ConfigureAwait(false);
        }
        else
        {
            var projection = new ArticlePublicTaxonomyProjection
            {
                ArticleId = articleId,
                CategoryId = current.CategoryId,
                TagIds = FormatTagIds(currentTagIds),
                UpdatedAtUtc = DateTime.UtcNow
            };
            await db.Storageable(projection)
                .WhereColumns(it => it.ArticleId)
                .ExecuteCommandAsync()
                .ConfigureAwait(false);
        }

        long version = 0;
        if (updatedRows > 0)
        {
            version = await BumpFrameVersionAsync("taxonomy-projection-delta", cancellationToken).ConfigureAwait(false);
            await httpCacheInvalidator.InvalidateAsync(CacheTag.Category, CacheTag.Tag).ConfigureAwait(false);
        }

        FsusObservability.RecordTaxonomyProjectionUpdate(updatedRows, version, stopwatch.Elapsed);
    }

    public async Task<long> BumpFrameVersionAsync(string reason, CancellationToken cancellationToken = default)
    {
        string? rawPreviousVersion = await cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", cancellationToken).ConfigureAwait(false);
        long previousVersion = long.TryParse(rawPreviousVersion, out long parsedPreviousVersion) && parsedPreviousVersion > 0
            ? parsedPreviousVersion
            : 0;
        long version = await cache.IncrementAsync(CachePolicyId.TaxonomyFrameVersion, "main", 1, cancellationToken).ConfigureAwait(false);
        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.CategoryFrame, "all"),
                new(CachePolicyId.TagFrame, "all"),
                new(CachePolicyId.CategoryFrame, $"v:{previousVersion}:all"),
                new(CachePolicyId.TagFrame, $"v:{previousVersion}:all"),
                new(CachePolicyId.CategoryFrame, $"v:{version}:all"),
                new(CachePolicyId.TagFrame, $"v:{version}:all")
            ],
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordTaxonomyFrameVersion(version, reason);
        return version;
    }

    private async Task<CurrentPublicTaxonomy> LoadCurrentAsync(int articleId)
    {
        Article? article = await db.Queryable<Article>().ClearFilter().InSingleAsync(articleId);
        if (article is null || !ArticlePublication.IsPubliclyVisible(article, DateTime.UtcNow))
        {
            return new CurrentPublicTaxonomy(null, []);
        }

        List<int> tagIds = await db.Queryable<ArticleTag>()
            .Where(it => it.ArticleId == articleId)
            .OrderBy(it => it.TagId)
            .Select(it => it.TagId)
            .ToListAsync()
            .ConfigureAwait(false);
        return new CurrentPublicTaxonomy(article.CategoryId, tagIds);
    }

    private async Task ApplyCategoryDeltaAsync(int categoryId, int delta)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO category_public_article_count(category_id, article_count, updated_at_utc)
            VALUES (@CategoryId, GREATEST(0, @Delta), now() AT TIME ZONE 'utc')
            ON CONFLICT (category_id) DO UPDATE
            SET article_count = GREATEST(0, category_public_article_count.article_count + @Delta),
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@CategoryId", categoryId),
            new SugarParameter("@Delta", delta)).ConfigureAwait(false);
    }

    private async Task ApplyTagDeltaAsync(int tagId, int delta)
    {
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO tag_public_article_count(tag_id, article_count, updated_at_utc)
            VALUES (@TagId, GREATEST(0, @Delta), now() AT TIME ZONE 'utc')
            ON CONFLICT (tag_id) DO UPDATE
            SET article_count = GREATEST(0, tag_public_article_count.article_count + @Delta),
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@TagId", tagId),
            new SugarParameter("@Delta", delta)).ConfigureAwait(false);
    }

    private static HashSet<int> ParseTagIds(string? value)
    {
        var result = new HashSet<int>();
        if (string.IsNullOrWhiteSpace(value))
        {
            return result;
        }

        foreach (string part in value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out int tagId) && tagId > 0)
            {
                result.Add(tagId);
            }
        }

        return result;
    }

    private static string FormatTagIds(IEnumerable<int> tagIds)
        => string.Join(',', tagIds.Order());

    private sealed record CurrentPublicTaxonomy(int? CategoryId, IReadOnlyList<int> TagIds);
}
