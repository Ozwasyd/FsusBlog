using System.Globalization;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

/// <summary>
/// The only persistent content-asset reference ledger. Every write entering
/// this store has already crossed the public URL boundary and carries AssetId.
/// </summary>
internal sealed class ArticleAssetReferenceStore(ISqlSugarClient db, TimeProvider? timeProvider = null)
{
    private static readonly TimeSpan s_cleanupDelay = TimeSpan.FromHours(24);
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    internal static TimeSpan CleanupDelay => s_cleanupDelay;

    /// <summary>
    /// The original authorized upload caller invokes this inside its open database transaction.
    /// Reuses canonical asset locks, reference absence and delayed scheduling; returns no receipt.
    /// </summary>
    public async Task ScheduleUnreferencedOwnedAssetsAsync(
        long ownerAdminPrincipalId,
        IReadOnlyCollection<AssetId> candidateAssetIds,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(candidateAssetIds);
        cancellationToken.ThrowIfCancellationRequested();
        if (ownerAdminPrincipalId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(ownerAdminPrincipalId));
        }
        if (db.Ado.Transaction is null)
        {
            throw new InvalidOperationException("content_asset_cleanup_transaction_required");
        }
        AssetId[] candidates = ParseAssetIds(candidateAssetIds.Select(static id => id.Value));
        await AcquireAssetLocksAsync(candidates, cancellationToken).ConfigureAwait(false);
        Guid[] ids = [.. candidates.Select(static id => id.Value)];
        List<Guid> owned = await db.Queryable<ContentAsset>()
            .Where(asset => ids.Contains(asset.AssetId) && asset.OwnerAdminPrincipalId == ownerAdminPrincipalId)
            .Select(asset => asset.AssetId)
            .ToListAsync(cancellationToken);
        if (owned.Count != candidates.Length)
        {
            throw new InvalidOperationException("content_asset_cleanup_owner_or_asset_changed");
        }
        await ScheduleIfUnreferencedAsync(candidates, cancellationToken).ConfigureAwait(false);
    }

    public Task ReplaceCurrentArticleAsync(
        int articleId,
        IReadOnlyCollection<ArticleAssetReferenceWrite> references,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ContentAssetSourceKinds.Article,
            articleId.ToString(CultureInfo.InvariantCulture),
            articleId,
            references,
            cancellationToken);

    public Task ReplaceDraftAsync(
        long ownerAdminPrincipalId,
        string draftKey,
        int? articleId,
        IReadOnlyCollection<ArticleAssetReferenceWrite> references,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ContentAssetSourceKinds.Draft,
            string.Concat(ownerAdminPrincipalId.ToString(CultureInfo.InvariantCulture), ":", draftKey),
            articleId,
            references,
            cancellationToken);

    public Task ReplaceRevisionAsync(
        long revisionId,
        int articleId,
        IReadOnlyCollection<ArticleAssetReferenceWrite> references,
        CancellationToken cancellationToken = default)
        => ReplaceSourceAsync(
            ContentAssetSourceKinds.Revision,
            revisionId.ToString(CultureInfo.InvariantCulture),
            articleId,
            references,
            cancellationToken);

    public Task RemoveDraftAsync(
        long ownerAdminPrincipalId,
        string draftKey,
        CancellationToken cancellationToken = default)
        => RemoveSourceAsync(
            ContentAssetSourceKinds.Draft,
            string.Concat(ownerAdminPrincipalId.ToString(CultureInfo.InvariantCulture), ":", draftKey),
            cancellationToken);

    public Task RemoveRevisionAsync(
        long revisionId,
        CancellationToken cancellationToken = default)
        => RemoveSourceAsync(
            ContentAssetSourceKinds.Revision,
            revisionId.ToString(CultureInfo.InvariantCulture),
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

    private async Task ReplaceSourceAsync(
        string sourceKind,
        string sourceKey,
        int? articleId,
        IReadOnlyCollection<ArticleAssetReferenceWrite> references,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await AcquireSourceLockAsync(sourceKind, sourceKey, cancellationToken).ConfigureAwait(false);
        List<Guid> previous = await db.Queryable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .Select(reference => reference.AssetId)
            .ToListAsync(cancellationToken);
        Dictionary<AssetId, DesiredReference> desired = NormalizeReferences(references);
        AssetId[] touched = ParseAssetIds(previous.Concat(desired.Keys.Select(static id => id.Value)));
        await AcquireAssetLocksAsync(touched, cancellationToken).ConfigureAwait(false);
        await EnsureAssetsAvailableAsync(desired.Keys, cancellationToken).ConfigureAwait(false);

        await db.Deleteable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .ExecuteCommandAsync(cancellationToken);
        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        ContentAssetReference[] inserted = [.. desired
            .OrderBy(static item => item.Key.ToString(), StringComparer.Ordinal)
            .Select(item => new ContentAssetReference
            {
                AssetId = item.Key.Value,
                SourceKind = sourceKind,
                SourceKey = sourceKey,
                ArticleId = articleId,
                ReferenceCount = item.Value.Count,
                AltText = item.Value.AltText,
                UpdatedAtUtc = now
            })];
        if (inserted.Length > 0)
        {
            await db.Insertable(inserted).ExecuteCommandAsync(cancellationToken);
        }

        await CancelQueuedCleanupAsync(desired.Keys, cancellationToken).ConfigureAwait(false);
        HashSet<AssetId> desiredIds = [.. desired.Keys];
        await ScheduleIfUnreferencedAsync(touched.Where(id => !desiredIds.Contains(id)), cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task RemoveSourceAsync(
        string sourceKind,
        string sourceKey,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await AcquireSourceLockAsync(sourceKind, sourceKey, cancellationToken).ConfigureAwait(false);
        List<Guid> previous = await db.Queryable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .Select(reference => reference.AssetId)
            .ToListAsync(cancellationToken);
        AssetId[] touched = ParseAssetIds(previous);
        await AcquireAssetLocksAsync(touched, cancellationToken).ConfigureAwait(false);
        await db.Deleteable<ContentAssetReference>()
            .Where(reference => reference.SourceKind == sourceKind && reference.SourceKey == sourceKey)
            .ExecuteCommandAsync(cancellationToken);
        await ScheduleIfUnreferencedAsync(touched, cancellationToken).ConfigureAwait(false);
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

        bool deleting = await db.Queryable<ContentAssetCleanupQueueItem>()
            .Where(item => expected.Contains(item.AssetId)
                && item.LastError == ContentAssetCleanupMarkers.DeletePending)
            .AnyAsync(cancellationToken);
        if (deleting)
        {
            throw new InvalidOperationException("content_asset_reference_delete_in_progress");
        }

        bool repairFenced = await db.Queryable<ContentAssetCleanupQueueItem>()
            .Where(item => expected.Contains(item.AssetId)
                && item.LastError == ContentAssetCleanupMarkers.PrivateCommitRepair)
            .AnyAsync(cancellationToken);
        if (repairFenced)
        {
            throw new InvalidOperationException("content_asset_reference_repair_in_progress");
        }
    }

    private async Task ScheduleIfUnreferencedAsync(IEnumerable<AssetId> assetIds, CancellationToken cancellationToken)
    {
        Guid[] ids = [.. assetIds.Select(static id => id.Value).Distinct().Order()];
        if (ids.Length == 0)
        {
            return;
        }

        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
                WITH candidate(asset_id) AS (
                    SELECT unnest(CAST(@AssetIds AS uuid[]))
                ),
                unreferenced(asset_id) AS (
                    SELECT candidate.asset_id
                    FROM candidate
                    WHERE NOT EXISTS (
                        SELECT 1
                        FROM content_asset_reference reference
                        WHERE reference.asset_id = candidate.asset_id
                    )
                ),
                queued AS (
                INSERT INTO content_asset_cleanup_queue
                    (asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
                    SELECT asset_id, @NotBeforeUtc, 0, NULL, @UpdatedAtUtc
                    FROM unreferenced
                ON CONFLICT (asset_id) DO UPDATE
                SET not_before_utc = LEAST(content_asset_cleanup_queue.not_before_utc, EXCLUDED.not_before_utc),
                    last_error = content_asset_cleanup_queue.last_error,
                        updated_at_utc = EXCLUDED.updated_at_utc
                    RETURNING asset_id
                )

                UPDATE content_asset
                SET state = 'pending_delete', updated_at_utc = @UpdatedAtUtc
                WHERE id IN (SELECT asset_id FROM queued);
                """,
            new SugarParameter("@AssetIds", FormatUuidArray(ids)),
            new SugarParameter("@NotBeforeUtc", now + CleanupDelay),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
    }

    private async Task CancelQueuedCleanupAsync(IEnumerable<AssetId> assetIds, CancellationToken cancellationToken)
    {
        Guid[] ids = [.. assetIds.Select(static id => id.Value).Distinct()];
        if (ids.Length == 0)
        {
            return;
        }

        DateTime now = _timeProvider.GetUtcNow().UtcDateTime;
        await db.Ado.ExecuteCommandAsync(
            """
            WITH recoverable AS (
                SELECT asset.id
                FROM content_asset asset
                LEFT JOIN content_asset_cleanup_queue cleanup ON cleanup.asset_id = asset.id
                WHERE asset.id = ANY(CAST(@AssetIds AS uuid[]))
                  AND (cleanup.asset_id IS NULL OR cleanup.last_error IS NULL)
            ), removed AS (
                DELETE FROM content_asset_cleanup_queue cleanup
                WHERE cleanup.asset_id IN (SELECT id FROM recoverable)
            )
            UPDATE content_asset asset
            SET state = 'active', updated_at_utc = @UpdatedAtUtc
            WHERE asset.id IN (SELECT id FROM recoverable);
            """,
            new SugarParameter("@AssetIds", FormatUuidArray(ids)),
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
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
        Guid[] ids = [.. assetIds.Select(static id => id.Value).Distinct().Order()];
        if (ids.Length == 0)
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            SELECT pg_advisory_xact_lock(hashtextextended(CAST(asset_id AS text), 1779))
            FROM unnest(CAST(@AssetIds AS uuid[])) asset_id
            ORDER BY asset_id;
            """,
            new SugarParameter("@AssetIds", FormatUuidArray(ids))).ConfigureAwait(false);
    }

    private static AssetId[] ParseAssetIds(IEnumerable<Guid> values)
        => [.. values.Select(AssetId.FromGuid).Distinct().OrderBy(static id => id.ToString(), StringComparer.Ordinal)];

    private static string FormatUuidArray(IEnumerable<Guid> values)
        => string.Concat("{", string.Join(',', values.Select(static value => value.ToString("D"))), "}");

    private static string? NormalizeAltText(string? value)
    {
        string? normalized = value?.Trim();
        return string.IsNullOrEmpty(normalized) ? null : normalized[..Math.Min(normalized.Length, 256)];
    }

    private static Dictionary<AssetId, DesiredReference> NormalizeReferences(
        IEnumerable<ArticleAssetReferenceWrite> references)
    {
        var normalized = new Dictionary<AssetId, DesiredReference>();
        foreach (ArticleAssetReferenceWrite reference in references)
        {
            if (reference.AssetId.Value == Guid.Empty || reference.ReferenceCount <= 0)
            {
                throw new ArgumentException("Content asset writes require a non-empty AssetId and positive reference count.", nameof(references));
            }

            string? altText = NormalizeAltText(reference.AltText);
            if (normalized.TryGetValue(reference.AssetId, out DesiredReference? current))
            {
                string? deterministicAlt = new[] { current.AltText, altText }
                    .Where(static value => value is not null)
                    .Order(StringComparer.Ordinal)
                    .FirstOrDefault();
                normalized[reference.AssetId] = new DesiredReference(
                    checked(current.Count + reference.ReferenceCount),
                    deterministicAlt);
            }
            else
            {
                normalized[reference.AssetId] = new DesiredReference(reference.ReferenceCount, altText);
            }
        }

        return normalized;
    }

    private sealed record DesiredReference(int Count, string? AltText);
}
