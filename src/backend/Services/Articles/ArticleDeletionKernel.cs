using FsusBlog.Server.Contracts.Assets;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Deletes the mutable, article-owned projection in one PostgreSQL transaction.
/// The caller must lock and recheck the soft-deleted article rows first.
/// Immutable revision, publication, proof, moderation and mutation-event history is retained.
/// </summary>
internal sealed class ArticleDeletionKernel(ISqlSugarClient db)
{
    internal async Task<int> DeleteLockedAsync(
        IReadOnlyCollection<int> articleIds,
        Func<int, Task> recordDeletionEventAsync,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(articleIds);
        ArgumentNullException.ThrowIfNull(recordDeletionEventAsync);

        int[] targets = [.. articleIds.Distinct().Order()];
        if (targets.Length == 0)
        {
            return 0;
        }

        cancellationToken.ThrowIfCancellationRequested();
        string idPlaceholders = string.Join(", ", targets.Select(static (_, index) => $"@ArticleId{index}"));
        SugarParameter[] idParameters = [.. targets.Select(
            static (articleId, index) => new SugarParameter($"@ArticleId{index}", articleId))];
        var assetReferences = new ArticleAssetReferenceStore(db);
        AssetId[] mutableAssetIds = await assetReferences
            .LoadMutableArticleSourceAssetIdsAsync(targets, cancellationToken)
            .ConfigureAwait(false);

        // These tables are current-state projections. Immutable revision/publication/proof and
        // append-only event tables are deliberately absent; their retention is catalogued in
        // docs/architecture/article-deletion-data-catalog.json.
        await db.Ado.ExecuteCommandAsync(
            $"""
            DELETE FROM article_draft
            WHERE article_id IN ({idPlaceholders});

            DELETE FROM article_canvas_link_history
            WHERE source_article_id IN ({idPlaceholders});

            DELETE FROM article_tag
            WHERE articleid IN ({idPlaceholders});

            DELETE FROM article_body
            WHERE article_id IN ({idPlaceholders});

            DELETE FROM article_public_taxonomy_projection
            WHERE article_id IN ({idPlaceholders});

            DELETE FROM public_article_projection
            WHERE article_id IN ({idPlaceholders});

            DELETE FROM article_view_seed
            WHERE article_id IN ({idPlaceholders});
            """,
            idParameters).ConfigureAwait(false);

        await assetReferences
            .RemoveMutableArticleSourcesAndScheduleAsync(targets, mutableAssetIds, cancellationToken)
            .ConfigureAwait(false);

        foreach (int articleId in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await recordDeletionEventAsync(articleId).ConfigureAwait(false);
        }

        int deleted = 0;
        foreach (int articleId in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            deleted += await db.Ado.ExecuteCommandAsync(
                """
                DELETE FROM article
                WHERE id = @ArticleId
                  AND isdeleted = true;
                """,
                new SugarParameter("@ArticleId", articleId)).ConfigureAwait(false);
        }
        if (deleted != targets.Length)
        {
            throw new InvalidOperationException(
                $"Article deletion target set changed while locked: expected {targets.Length}, deleted {deleted}.");
        }

        return deleted;
    }
}
