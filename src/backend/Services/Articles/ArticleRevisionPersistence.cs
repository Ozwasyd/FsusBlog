using System.Data.Common;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Infrastructure.Data;

using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// Production-shared article revision insert used by <c>ArticleService.SaveArticleRevisionAsync</c>
/// and canonical publication fixture authority.
/// </summary>
public readonly record struct ArticleRevisionWriteResult(long Id, int RevisionNo, long ContentBlockId);

public static class ArticleRevisionPersistence
{
    public const int MaxInsertAttempts = 3;

    public static Task<ArticleRevisionWriteResult> SaveAsync(
        ISqlSugarClient db,
        int articleId,
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        IReadOnlyList<int> tagIds,
        string diffSummary,
        DateTime createdAt,
        long createdByAdminPrincipalId,
        long? rollbackSourceRevisionId = null,
        string? rollbackReason = null,
        ILogger? logger = null,
        CancellationToken cancellationToken = default)
        => SaveCoreAsync(db, articleId, title, content, summary, coverImageUrl, categoryId,
            tagIds, diffSummary, createdAt, createdByAdminPrincipalId, rollbackSourceRevisionId,
            rollbackReason, logger, cancellationToken, allowUntitledEditableRevision: false);

    // Only the lifecycle writer may carry an existing blank editable article through a
    // status-only command. Ordinary content/publication writes retain the title guard.
    internal static Task<ArticleRevisionWriteResult> SaveEditableLifecycleAsync(
        ISqlSugarClient db, int articleId, string title, string content, string? summary,
        string? coverImageUrl, int categoryId, IReadOnlyList<int> tagIds, string diffSummary,
        DateTime createdAt, long createdByAdminPrincipalId, CancellationToken cancellationToken)
        => SaveCoreAsync(db, articleId, title, content, summary, coverImageUrl, categoryId,
            tagIds, diffSummary, createdAt, createdByAdminPrincipalId, null, null, null,
            cancellationToken, allowUntitledEditableRevision: true);

    private static async Task<ArticleRevisionWriteResult> SaveCoreAsync(
        ISqlSugarClient db,
        int articleId,
        string title,
        string content,
        string? summary,
        string? coverImageUrl,
        int categoryId,
        IReadOnlyList<int> tagIds,
        string diffSummary,
        DateTime createdAt,
        long createdByAdminPrincipalId,
        long? rollbackSourceRevisionId,
        string? rollbackReason,
        ILogger? logger,
        CancellationToken cancellationToken,
        bool allowUntitledEditableRevision)
    {
        ArgumentNullException.ThrowIfNull(db);
        ArgumentNullException.ThrowIfNull(title);
        if (!allowUntitledEditableRevision)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(title);
        }
        ArgumentNullException.ThrowIfNull(content);
        ArgumentException.ThrowIfNullOrWhiteSpace(diffSummary);

        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext('article_revision'), @articleId);",
            new SugarParameter[] { new("@articleId", articleId) }).ConfigureAwait(false);

        string orderedTagIds = ArticleRevisionStorageEncoding.EncodeTagIds(tagIds);
        long contentBlockId = await ArticleRevisionContentBlockStore.GetOrCreateAsync(
            db,
            content,
            createdAt,
            cancellationToken).ConfigureAwait(false);

        for (int attempt = 1; attempt <= MaxInsertAttempts; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                WITH locked_article AS (
                    SELECT id, xmin::text AS row_version
                    FROM article
                    WHERE id = @articleId
                      AND isdeleted = false
                    FOR UPDATE
                ),
                next_revision AS (
                    SELECT locked_article.id AS article_id,
                           locked_article.row_version,
                           COALESCE((
                               SELECT MAX(revision_no)
                               FROM article_revision
                               WHERE article_id = @articleId
                           ), 0) + 1 AS revision_no
                    FROM locked_article
                )
                INSERT INTO article_revision (
                    article_id,
                    revision_no,
                    title,
                    summary,
                    cover_image_url,
                    categoryid,
                    tag_ids,
                    content_block_id,
                    markdown_content,
                    diff_summary,
                    created_by_admin_principal_id,
                    rollback_source_revision_id,
                    rollback_reason,
                    created_at
                )
                SELECT
                    article_id,
                    revision_no,
                    @title,
                    @summary,
                    @coverImageUrl,
                    @categoryId,
                    @tagIds,
                    @contentBlockId,
                    '',
                    @diffSummary,
                    @createdByAdminPrincipalId,
                    CAST(@rollbackSourceRevisionId AS bigint),
                    @rollbackReason,
                    @createdAt
                FROM next_revision
                ON CONFLICT (article_id, revision_no) DO NOTHING
                RETURNING id, revision_no;
                """,
                new SugarParameter[]
                {
                    new("@articleId", articleId),
                    new("@title", title),
                    new("@summary", summary),
                    new("@coverImageUrl", coverImageUrl),
                    new("@categoryId", categoryId),
                    new("@tagIds", orderedTagIds),
                    new("@contentBlockId", contentBlockId),
                    new("@diffSummary", diffSummary),
                    new("@createdByAdminPrincipalId", createdByAdminPrincipalId),
                    new("@rollbackSourceRevisionId", (object?)rollbackSourceRevisionId ?? DBNull.Value),
                    new("@rollbackReason", (object?)rollbackReason ?? DBNull.Value),
                    new("@createdAt", createdAt)
                }).ConfigureAwait(false);

            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                return new ArticleRevisionWriteResult(
                    reader.ReadInt64("id"),
                    reader.ReadInt32("revision_no"),
                    contentBlockId);
            }
            await reader.DisposeAsync().ConfigureAwait(false);

            int activeArticle = await db.Ado.GetIntAsync(
                "SELECT COUNT(1) FROM article WHERE id = @articleId AND isdeleted = false;",
                new SugarParameter[] { new("@articleId", articleId) }).ConfigureAwait(false);
            if (activeArticle == 0)
            {
                throw new InvalidOperationException($"Article revision was not created for article {articleId}.");
            }

            if (attempt < MaxInsertAttempts)
            {
                logger?.LogWarning(
                    "Article revision number conflict for {ArticleId}; retrying bounded attempt {Attempt}/{MaxAttempts}",
                    articleId,
                    attempt,
                    MaxInsertAttempts);
            }
        }

        throw new InvalidOperationException(
            $"Article revision conflict retry limit exceeded for article {articleId} after {MaxInsertAttempts} attempts.");
    }
}
