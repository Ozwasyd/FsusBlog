using System.Globalization;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// The only persistent content-asset reference ledger. Public URLs are decoded
/// at the write boundary and immediately resolved to <see cref="AssetId"/>.
/// </summary>
internal sealed class ArticleAssetReferenceStore(ISqlSugarClient db, TimeProvider? timeProvider = null)
{
    private static readonly TimeSpan s_cleanupDelay = TimeSpan.FromHours(24);
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;
    private readonly PublicAssetUrlCodec _urlCodec = new();

    internal static TimeSpan CleanupDelay => s_cleanupDelay;

    public Task ReplaceCurrentArticleAsync(
        int articleId,
        string markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ContentAssetSourceKinds.Article,
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
            ContentAssetSourceKinds.Draft,
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
            ContentAssetSourceKinds.Revision,
            revisionId.ToString(CultureInfo.InvariantCulture),
            articleId,
            markdownContent,
            coverImageUrl,
            cancellationToken);

    public async Task RemoveCurrentArticlesAndScheduleAsync(
        IReadOnlyCollection<int> articleIds,
        IEnumerable<AssetId> candidateAssetIds,
        CancellationToken cancellationToken = default)
    {
        string[] sourceKeys = [.. articleIds.Distinct().Select(static id => id.ToString(CultureInfo.InvariantCulture))];
        if (sourceKeys.Length == 0)
        {
            return;
        }

        List<Guid> tracked = await db.Queryable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == ContentAssetSourceKinds.Article
                && sourceKeys.Contains(reference.SourceKey))
            .Select(reference => reference.AssetId)
            .ToListAsync(cancellationToken);
        AssetId[] touched = ParseAssetIds(candidateAssetIds.Select(static id => id.Value).Concat(tracked));
        await AcquireAssetLocksAsync(touched, cancellationToken).ConfigureAwait(false);
        await db.Deleteable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == ContentAssetSourceKinds.Article
                && sourceKeys.Contains(reference.SourceKey))
            .ExecuteCommandAsync(cancellationToken);
        await ScheduleIfUnreferencedAsync(touched, cancellationToken).ConfigureAwait(false);
    }

    public async Task<AssetId[]> LoadMutableArticleSourceAssetIdsAsync(
        IReadOnlyCollection<int> articleIds,
        CancellationToken cancellationToken = default)
    {
        int[] targets = [.. articleIds.Distinct()];
        if (targets.Length == 0)
        {
            return [];
        }

        List<Guid> tracked = await db.Queryable<ContentAssetReference>()
            .Where(reference => reference.ArticleId != null
                && targets.Contains(reference.ArticleId.Value)
                && (reference.SourceKind == ContentAssetSourceKinds.Article
                    || reference.SourceKind == ContentAssetSourceKinds.Draft))
            .Select(reference => reference.AssetId)
            .ToListAsync(cancellationToken);
        return ParseAssetIds(tracked);
    }

    public async Task RemoveMutableArticleSourcesAndScheduleAsync(
        IReadOnlyCollection<int> articleIds,
        IEnumerable<AssetId> candidateAssetIds,
        CancellationToken cancellationToken = default)
    {
        int[] targets = [.. articleIds.Distinct()];
        if (targets.Length == 0)
        {
            return;
        }

        List<Guid> tracked = await db.Queryable<ContentAssetReference>()
            .Where(reference => reference.ArticleId != null
                && targets.Contains(reference.ArticleId.Value)
                && (reference.SourceKind == ContentAssetSourceKinds.Article
                    || reference.SourceKind == ContentAssetSourceKinds.Draft))
            .Select(reference => reference.AssetId)
            .ToListAsync(cancellationToken);
        AssetId[] touched = ParseAssetIds(candidateAssetIds.Select(static id => id.Value).Concat(tracked));
        await AcquireAssetLocksAsync(touched, cancellationToken).ConfigureAwait(false);
        await db.Deleteable<ContentAssetReference>()
            .Where(reference => reference.ArticleId != null
                && targets.Contains(reference.ArticleId.Value)
                && (reference.SourceKind == ContentAssetSourceKinds.Article
                    || reference.SourceKind == ContentAssetSourceKinds.Draft))
            .ExecuteCommandAsync(cancellationToken);
        await ScheduleIfUnreferencedAsync(touched, cancellationToken).ConfigureAwait(false);
    }

    public Task<int> CountAsync(CancellationToken cancellationToken = default)
        => db.Queryable<ContentAssetReference>().CountAsync(cancellationToken);

    internal async Task AcquireAssetLockAsync(AssetId assetId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
            new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);
    }

    internal static string[] ExtractPublicAssetUrls(string? markdownContent, string? coverImageUrl)
    {
        var urls = new HashSet<string>(StringComparer.Ordinal);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent ?? string.Empty))
        {
            urls.Add(reference.Url);
        }

        if (!string.IsNullOrWhiteSpace(coverImageUrl)
            && coverImageUrl.StartsWith(PublicAssetUrlCodec.RoutePrefix, StringComparison.Ordinal))
        {
            urls.Add(coverImageUrl);
        }

        return [.. urls.Order(StringComparer.Ordinal)];
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
        await AcquireSourceLockAsync(sourceKind, sourceKey, cancellationToken).ConfigureAwait(false);
        List<Guid> previous = await db.Queryable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .Select(reference => reference.AssetId)
            .ToListAsync(cancellationToken);
        Dictionary<AssetId, DesiredReference> desired = await ResolveReferencesAsync(
            markdownContent,
            coverImageUrl,
            cancellationToken).ConfigureAwait(false);
        AssetId[] touched = ParseAssetIds(previous.Concat(desired.Keys.Select(static id => id.Value)));
        await AcquireAssetLocksAsync(touched, cancellationToken).ConfigureAwait(false);
        await EnsureAssetsAvailableAsync(desired.Keys, cancellationToken).ConfigureAwait(false);

        await db.Deleteable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .ExecuteCommandAsync(cancellationToken);
        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        foreach ((AssetId assetId, DesiredReference reference) in desired.OrderBy(static item => item.Key.ToString(), StringComparer.Ordinal))
        {
            await db.Insertable(new ContentAssetReference
            {
                AssetId = assetId.Value,
                SourceKind = sourceKind,
                SourceKey = sourceKey,
                ArticleId = articleId,
                ReferenceCount = reference.Count,
                AltText = reference.AltText,
                UpdatedAtUtc = now
            }).ExecuteCommandAsync(cancellationToken);
        }

        await CancelQueuedCleanupAsync(desired.Keys, cancellationToken).ConfigureAwait(false);
        HashSet<AssetId> desiredIds = [.. desired.Keys];
        await ScheduleIfUnreferencedAsync(touched.Where(id => !desiredIds.Contains(id)), cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<Dictionary<AssetId, DesiredReference>> ResolveReferencesAsync(
        string markdownContent,
        string? coverImageUrl,
        CancellationToken cancellationToken)
    {
        var requested = new Dictionary<string, DesiredReference>(StringComparer.Ordinal);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdownContent ?? string.Empty))
        {
            Add(
                reference.Url,
                reference.AltText,
                CountOccurrences(markdownContent, reference.Url));
        }

        Add(coverImageUrl, null, 1);
        if (requested.Count == 0)
        {
            return [];
        }

        string[] storageKeys = [.. requested.Keys.Order(StringComparer.Ordinal)];
        List<ContentAsset> assets = await db.Queryable<ContentAsset>()
            .Where(asset => storageKeys.Contains(asset.StorageKey))
            .ToListAsync(cancellationToken);
        Dictionary<string, ContentAsset> byKey = assets.ToDictionary(static asset => asset.StorageKey, StringComparer.Ordinal);
        string[] missing = [.. storageKeys.Where(key => !byKey.ContainsKey(key))];
        if (missing.Length > 0)
        {
            throw new InvalidOperationException("content_asset_reference_missing_asset:" + string.Join(',', missing));
        }

        var result = new Dictionary<AssetId, DesiredReference>();
        foreach ((string storageKey, DesiredReference reference) in requested)
        {
            ContentAsset asset = byKey[storageKey];
            if (!ContentAssetStates.IsValid(asset.State))
            {
                throw new InvalidOperationException($"content_asset_not_active:{asset.AssetId}:{asset.State}");
            }

            result.Add(AssetId.FromGuid(asset.AssetId), reference);
        }

        return result;

        void Add(string? publicUrl, string? altText, int count)
        {
            if (string.IsNullOrWhiteSpace(publicUrl) || count <= 0)
            {
                return;
            }

            if (!_urlCodec.TryGetStorageKey(publicUrl, out AssetStorageKey storageKey))
            {
                if (publicUrl.StartsWith(PublicAssetUrlCodec.RoutePrefix, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException($"content_asset_public_url_invalid:{publicUrl}");
                }

                return;
            }

            if (requested.TryGetValue(storageKey.Value, out DesiredReference? current))
            {
                requested[storageKey.Value] = current with
                {
                    Count = current.Count + count,
                    AltText = current.AltText ?? NormalizeAltText(altText)
                };
            }
            else
            {
                requested[storageKey.Value] = new DesiredReference(count, NormalizeAltText(altText));
            }
        }
    }

    private async Task EnsureAssetsAvailableAsync(
        IEnumerable<AssetId> assetIds,
        CancellationToken cancellationToken)
    {
        Guid[] expected = [.. assetIds.Select(static id => id.Value).Distinct()];
        if (expected.Length == 0)
        {
            return;
        }

        List<ContentAsset> assets = await db.Queryable<ContentAsset>()
            .Where(asset => expected.Contains(asset.AssetId))
            .ToListAsync(cancellationToken);
        if (assets.Count != expected.Length)
        {
            throw new InvalidOperationException("content_asset_reference_asset_disappeared");
        }
        if (assets.Any(static asset => !ContentAssetStates.IsValid(asset.State)))
        {
            throw new InvalidOperationException("content_asset_reference_asset_state_invalid");
        }
    }

    private async Task ScheduleIfUnreferencedAsync(IEnumerable<AssetId> assetIds, CancellationToken cancellationToken)
    {
        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        foreach (AssetId assetId in assetIds.Distinct().OrderBy(static id => id.ToString(), StringComparer.Ordinal))
        {
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO content_asset_cleanup_queue
                    (asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
                SELECT @AssetId, @NotBeforeUtc, 0, NULL, @UpdatedAtUtc
                WHERE NOT EXISTS (SELECT 1 FROM content_asset_reference WHERE asset_id = @AssetId)
                ON CONFLICT (asset_id) DO UPDATE
                SET not_before_utc = LEAST(content_asset_cleanup_queue.not_before_utc, EXCLUDED.not_before_utc),
                    last_error = NULL,
                    updated_at_utc = EXCLUDED.updated_at_utc;

                UPDATE content_asset
                SET state = 'pending_delete', updated_at_utc = @UpdatedAtUtc
                WHERE id = @AssetId
                  AND NOT EXISTS (SELECT 1 FROM content_asset_reference WHERE asset_id = @AssetId);
                """,
                new SugarParameter("@AssetId", assetId.Value),
                new SugarParameter("@NotBeforeUtc", now + CleanupDelay),
                new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
        }
    }

    private async Task CancelQueuedCleanupAsync(IEnumerable<AssetId> assetIds, CancellationToken cancellationToken)
    {
        Guid[] ids = [.. assetIds.Select(static id => id.Value).Distinct()];
        if (ids.Length == 0)
        {
            return;
        }

        await db.Deleteable<ContentAssetCleanupQueueItem>()
            .Where(item => ids.Contains(item.AssetId))
            .ExecuteCommandAsync(cancellationToken);
        await db.Updateable<ContentAsset>()
            .SetColumns(asset => new ContentAsset
            {
                State = ContentAssetStates.Active,
                UpdatedAtUtc = _timeProvider.GetUtcNow().UtcDateTime
            })
            .Where(asset => ids.Contains(asset.AssetId))
            .ExecuteCommandAsync(cancellationToken);
    }

    private Task AcquireSourceLockAsync(string sourceKind, string sourceKey, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        return db.Ado.ExecuteCommandAsync(
            "SELECT pg_advisory_xact_lock(hashtextextended(@SourceIdentity, 1779));",
            new SugarParameter("@SourceIdentity", string.Concat(sourceKind, ":", sourceKey)));
    }

    private async Task AcquireAssetLocksAsync(IEnumerable<AssetId> assetIds, CancellationToken cancellationToken)
    {
        foreach (AssetId assetId in assetIds.Distinct().OrderBy(static id => id.ToString(), StringComparer.Ordinal))
        {
            await AcquireAssetLockAsync(assetId, cancellationToken).ConfigureAwait(false);
        }
    }

    private static AssetId[] ParseAssetIds(IEnumerable<Guid> values)
        => [.. values.Select(AssetId.FromGuid).Distinct().OrderBy(static id => id.ToString(), StringComparer.Ordinal)];

    private static string? NormalizeAltText(string? value)
    {
        string? normalized = value?.Trim();
        return string.IsNullOrEmpty(normalized) ? null : normalized[..Math.Min(normalized.Length, 256)];
    }

    private static int CountOccurrences(string? source, string value)
    {
        int count = 0;
        int offset = 0;
        while (!string.IsNullOrEmpty(source)
            && offset < source.Length
            && source.IndexOf(value, offset, StringComparison.Ordinal) is int index
            && index >= 0)
        {
            count++;
            offset = index + value.Length;
        }

        return count;
    }

    private sealed record DesiredReference(int Count, string? AltText);
}
