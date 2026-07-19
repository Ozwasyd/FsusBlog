using System.Data.Common;
using System.Globalization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

public static class ArticleAssetUrlNormalizer
{
    private const string UploadPrefix = "/uploads/illustration/";
    private static readonly HashSet<string> s_extensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".svg"
    };

    public static bool TryNormalize(string? rawUrl, out string normalizedUrl)
    {
        normalizedUrl = string.Empty;
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            return false;
        }

        string candidate = rawUrl.Trim().Replace('\\', '/');
        int suffixStart = candidate.IndexOfAny(['?', '#']);
        if (suffixStart >= 0)
        {
            candidate = candidate[..suffixStart];
        }

        try
        {
            candidate = Uri.UnescapeDataString(candidate);
        }
        catch (UriFormatException)
        {
            return false;
        }

        candidate = CollapseSlashes(candidate);
        candidate = "/" + candidate.TrimStart('/');
        string[] segments = candidate.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Any(static segment => segment is "." or ".." || segment.IndexOf('\0') >= 0))
        {
            return false;
        }

        if (!candidate.StartsWith(UploadPrefix, StringComparison.OrdinalIgnoreCase)
            || !s_extensions.Contains(Path.GetExtension(candidate)))
        {
            return false;
        }

        normalizedUrl = candidate.ToLowerInvariant();
        return normalizedUrl.Length <= 512;
    }

    private static string CollapseSlashes(string value)
    {
        Span<char> buffer = value.Length <= 512 ? stackalloc char[value.Length] : new char[value.Length];
        int written = 0;
        bool previousSlash = false;
        foreach (char character in value)
        {
            bool slash = character == '/';
            if (slash && previousSlash)
            {
                continue;
            }

            buffer[written++] = character;
            previousSlash = slash;
        }

        return new string(buffer[..written]);
    }
}

internal sealed class ArticleAssetReferenceStore(ISqlSugarClient db, TimeProvider? timeProvider = null)
{
    private static readonly TimeSpan s_cleanupDelay = TimeSpan.FromHours(24);
    internal static TimeSpan CleanupDelay => s_cleanupDelay;
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    public Task ReplaceCurrentArticleAsync(
        int articleId,
        string markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ArticleAssetSourceKinds.CurrentArticle,
            articleId.ToString(CultureInfo.InvariantCulture),
            articleId,
            markdownContent,
            coverImageUrl,
            cancellationToken);

    public Task ReplaceDraftAsync(
        long ownerAdminPrincipalId,
        string draftKey,
        int? articleId,
        string markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ArticleAssetSourceKinds.Draft,
            string.Concat(ownerAdminPrincipalId.ToString(CultureInfo.InvariantCulture), ":", draftKey),
            articleId,
            markdownContent,
            coverImageUrl,
            cancellationToken);

    public Task ReplaceRevisionAsync(
        long revisionId,
        int articleId,
        string markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ArticleAssetSourceKinds.Revision,
            revisionId.ToString(CultureInfo.InvariantCulture),
            articleId,
            markdownContent,
            coverImageUrl,
            cancellationToken);

    public async Task RemoveCurrentArticlesAndScheduleAsync(
        IReadOnlyCollection<int> articleIds,
        IEnumerable<string> candidateUrls,
        CancellationToken cancellationToken = default)
    {
        if (articleIds.Count == 0)
        {
            return;
        }

        await AcquireLedgerLockAsync(cancellationToken).ConfigureAwait(false);
        string[] sourceKeys = [.. articleIds.Select(static id => id.ToString(CultureInfo.InvariantCulture))];
        List<string> trackedUrls = await db.Queryable<ArticleAssetReference>()
            .Where(reference => reference.SourceKind == ArticleAssetSourceKinds.CurrentArticle
                && sourceKeys.Contains(reference.SourceKey))
            .Select(reference => reference.NormalizedUrl)
            .ToListAsync(cancellationToken);
        string[] normalizedCandidates = NormalizeUrls(candidateUrls.Concat(trackedUrls));
        await AcquireUrlLocksAsync(normalizedCandidates, cancellationToken).ConfigureAwait(false);

        await db.Deleteable<ArticleAssetReference>()
            .Where(reference => reference.SourceKind == ArticleAssetSourceKinds.CurrentArticle
                && sourceKeys.Contains(reference.SourceKey))
            .ExecuteCommandAsync(cancellationToken);
        await ScheduleIfUnreferencedAsync(normalizedCandidates, cancellationToken).ConfigureAwait(false);
    }

    public async Task ReconcileUrlsAsync(IEnumerable<string> candidateUrls, CancellationToken cancellationToken = default)
    {
        string[] normalizedCandidates = NormalizeUrls(candidateUrls);
        if (normalizedCandidates.Length == 0)
        {
            return;
        }

        await AcquireLedgerLockAsync(cancellationToken).ConfigureAwait(false);
        await AcquireUrlLocksAsync(normalizedCandidates, cancellationToken).ConfigureAwait(false);
        await db.Deleteable<ArticleAssetReference>()
            .Where(reference => normalizedCandidates.Contains(reference.NormalizedUrl))
            .ExecuteCommandAsync(cancellationToken);

        HashSet<string> candidates = [.. normalizedCandidates];
        foreach (SourceSnapshot source in await LoadAllSourcesAsync(cancellationToken).ConfigureAwait(false))
        {
            Dictionary<string, int> references = BuildReferenceCounts(source.MarkdownContent, source.CoverImageUrl);
            foreach ((string normalizedUrl, int count) in references)
            {
                if (candidates.Contains(normalizedUrl))
                {
                    await UpsertReferenceAsync(source.SourceKind, source.SourceKey, source.ArticleId, normalizedUrl, count, cancellationToken)
                        .ConfigureAwait(false);
                }
            }
        }

        await CancelQueuedCleanupAsync(normalizedCandidates, cancellationToken).ConfigureAwait(false);
    }

    public async Task RebuildAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await AcquireLedgerLockAsync(cancellationToken).ConfigureAwait(false);
        List<SourceSnapshot> sources = await LoadAllSourcesAsync(cancellationToken).ConfigureAwait(false);
        string[] urls = [.. sources
            .SelectMany(static source => BuildReferenceCounts(source.MarkdownContent, source.CoverImageUrl).Keys)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];
        await AcquireUrlLocksAsync(urls, cancellationToken).ConfigureAwait(false);
        await db.Deleteable<ArticleAssetReference>().ExecuteCommandAsync(cancellationToken);
        foreach (SourceSnapshot source in sources)
        {
            foreach ((string normalizedUrl, int count) in BuildReferenceCounts(source.MarkdownContent, source.CoverImageUrl))
            {
                await UpsertReferenceAsync(source.SourceKind, source.SourceKey, source.ArticleId, normalizedUrl, count, cancellationToken)
                    .ConfigureAwait(false);
            }
        }

        await CancelQueuedCleanupAsync(urls, cancellationToken).ConfigureAwait(false);
    }

    private async Task ReplaceSourceAsync(
        string sourceKind,
        string sourceKey,
        int? articleId,
        string markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await AcquireLedgerLockAsync(cancellationToken).ConfigureAwait(false);
        await AcquireSourceLockAsync(sourceKind, sourceKey, cancellationToken).ConfigureAwait(false);
        List<string> previousUrls = await db.Queryable<ArticleAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .Select(reference => reference.NormalizedUrl)
            .ToListAsync(cancellationToken);
        Dictionary<string, int> desired = BuildReferenceCounts(markdownContent, coverImageUrl);
        string[] touchedUrls = [.. previousUrls.Concat(desired.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)];
        await AcquireUrlLocksAsync(touchedUrls, cancellationToken).ConfigureAwait(false);

        await db.Deleteable<ArticleAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .ExecuteCommandAsync(cancellationToken);
        foreach ((string normalizedUrl, int count) in desired)
        {
            await UpsertReferenceAsync(sourceKind, sourceKey, articleId, normalizedUrl, count, cancellationToken)
                .ConfigureAwait(false);
        }

        await CancelQueuedCleanupAsync(desired.Keys, cancellationToken).ConfigureAwait(false);
        await ScheduleIfUnreferencedAsync(previousUrls.Except(desired.Keys, StringComparer.Ordinal), cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<List<SourceSnapshot>> LoadAllSourcesAsync(CancellationToken cancellationToken)
    {
        List<Article> articles = await db.Queryable<Article>().ClearFilter().ToListAsync(cancellationToken);
        List<ArticleBody> bodies = await db.Queryable<ArticleBody>().ToListAsync(cancellationToken);
        Dictionary<int, string> bodiesByArticleId = bodies.ToDictionary(
            static body => body.ArticleId,
            static body => body.MarkdownContent);
        var sources = new List<SourceSnapshot>(articles.Count);
        foreach (Article article in articles)
        {
            sources.Add(new SourceSnapshot(
                ArticleAssetSourceKinds.CurrentArticle,
                article.Id.ToString(CultureInfo.InvariantCulture),
                article.Id,
                bodiesByArticleId.GetValueOrDefault(article.Id, string.Empty),
                article.CoverImageUrl));
        }

        foreach (ArticleDraft draft in await db.Queryable<ArticleDraft>().ToListAsync(cancellationToken))
        {
            sources.Add(new SourceSnapshot(
                ArticleAssetSourceKinds.Draft,
                string.Concat(draft.OwnerAdminPrincipalId.ToString(CultureInfo.InvariantCulture), ":", draft.DraftKey),
                draft.ArticleId,
                draft.MarkdownContent,
                draft.CoverImageUrl));
        }

        foreach (ArticleRevision revision in await db.Queryable<ArticleRevision>().ToListAsync(cancellationToken))
        {
            sources.Add(new SourceSnapshot(
                ArticleAssetSourceKinds.Revision,
                revision.Id.ToString(CultureInfo.InvariantCulture),
                revision.ArticleId,
                revision.MarkdownContent,
                revision.CoverImageUrl));
        }

        return sources;
    }

    private async Task UpsertReferenceAsync(
        string sourceKind,
        string sourceKey,
        int? articleId,
        string normalizedUrl,
        int referenceCount,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO article_asset_reference
                (normalized_url, source_kind, source_key, article_id, reference_count, updated_at_utc)
            VALUES
                (@NormalizedUrl, @SourceKind, @SourceKey, CAST(@ArticleId AS integer), @ReferenceCount, @UpdatedAtUtc)
            ON CONFLICT (normalized_url, source_kind, source_key) DO UPDATE
            SET article_id = EXCLUDED.article_id,
                reference_count = EXCLUDED.reference_count,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@NormalizedUrl", normalizedUrl),
            new SugarParameter("@SourceKind", sourceKind),
            new SugarParameter("@SourceKey", sourceKey),
            new SugarParameter("@ArticleId", articleId.HasValue ? articleId.Value : DBNull.Value),
            new SugarParameter("@ReferenceCount", referenceCount),
            new SugarParameter("@UpdatedAtUtc", _timeProvider.GetUtcNow().UtcDateTime)).ConfigureAwait(false);
    }

    private async Task ScheduleIfUnreferencedAsync(IEnumerable<string> urls, CancellationToken cancellationToken)
    {
        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        foreach (string url in urls.Distinct(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO article_asset_cleanup_queue
                    (normalized_url, not_before_utc, attempt_count, last_error, updated_at_utc)
                SELECT @NormalizedUrl, @NotBeforeUtc, 0, NULL, @UpdatedAtUtc
                WHERE NOT EXISTS (
                    SELECT 1
                    FROM article_asset_reference
                    WHERE normalized_url = @NormalizedUrl
                )
                ON CONFLICT (normalized_url) DO UPDATE
                SET not_before_utc = LEAST(article_asset_cleanup_queue.not_before_utc, EXCLUDED.not_before_utc),
                    last_error = NULL,
                    updated_at_utc = EXCLUDED.updated_at_utc;
                """,
                new SugarParameter("@NormalizedUrl", url),
                new SugarParameter("@NotBeforeUtc", now + CleanupDelay),
                new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
        }
    }

    private Task CancelQueuedCleanupAsync(IEnumerable<string> urls, CancellationToken cancellationToken)
    {
        string[] normalized = [.. urls.Distinct(StringComparer.Ordinal)];
        if (normalized.Length == 0)
        {
            return Task.CompletedTask;
        }

        return db.Deleteable<ArticleAssetCleanupQueueItem>()
            .Where(item => normalized.Contains(item.NormalizedUrl))
            .ExecuteCommandAsync(cancellationToken);
    }

    private async Task AcquireSourceLockAsync(string sourceKind, string sourceKey, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext('article_asset_source'), hashtext(@SourceIdentity));",
            new SugarParameter("@SourceIdentity", string.Concat(sourceKind, ":", sourceKey))).ConfigureAwait(false);
    }

    private async Task AcquireLedgerLockAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync("SELECT pg_advisory_xact_lock(hashtext('article_asset_reference_ledger'));")
            .ConfigureAwait(false);
    }

    internal async Task AcquireUrlLockAsync(string normalizedUrl, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtext('article_asset_url'), hashtext(@NormalizedUrl));",
            new SugarParameter("@NormalizedUrl", normalizedUrl)).ConfigureAwait(false);
    }

    private async Task AcquireUrlLocksAsync(IEnumerable<string> urls, CancellationToken cancellationToken)
    {
        foreach (string url in urls.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            await AcquireUrlLockAsync(url, cancellationToken).ConfigureAwait(false);
        }
    }

    internal static Dictionary<string, int> BuildReferenceCounts(string? markdownContent, string? coverImageUrl)
    {
        var references = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent ?? string.Empty))
        {
            Add(reference.Url);
        }

        Add(coverImageUrl);
        return references;

        void Add(string? rawUrl)
        {
            if (!ArticleAssetUrlNormalizer.TryNormalize(rawUrl, out string normalizedUrl))
            {
                return;
            }

            references.TryGetValue(normalizedUrl, out int count);
            references[normalizedUrl] = count + 1;
        }
    }

    private static string[] NormalizeUrls(IEnumerable<string> urls)
        => [.. urls
            .Select(static url => ArticleAssetUrlNormalizer.TryNormalize(url, out string normalized) ? normalized : null)
            .Where(static url => url is not null)
            .Select(static url => url!)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)];

    private sealed record SourceSnapshot(
        string SourceKind,
        string SourceKey,
        int? ArticleId,
        string MarkdownContent,
        string? CoverImageUrl);
}
