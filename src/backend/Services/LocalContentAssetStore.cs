using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed class LocalContentAssetStore(
    ISqlSugarClient db,
    ReleaseStoragePaths storagePaths,
    ILogger<LocalContentAssetStore> logger) : IAssetStore
{
    private const int ReferenceSummaryLimit = 16;

    private readonly string _publicRoot = Path.GetFullPath(storagePaths.PublicAssetRoot);

    public async Task<AssetDeleteOutcome> DeleteAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        AssetDeleteOutcome outcome = new(AssetDeleteResult.NotFound);
        string? deletionPath = null;
        var transaction = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
                new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);

            ContentAsset? asset = await db.Queryable<ContentAsset>()
                .Where(item => item.AssetId == assetId.Value)
                .FirstAsync(cancellationToken);
            if (asset is null)
            {
                outcome = new AssetDeleteOutcome(AssetDeleteResult.NotFound);
                return;
            }

            int sourceCount = await db.Queryable<ContentAssetReference>()
                .Where(reference => reference.AssetId == asset.AssetId)
                .CountAsync(cancellationToken);
            if (sourceCount > 0)
            {
                List<ContentAssetReference> references = await db.Queryable<ContentAssetReference>()
                    .Where(reference => reference.AssetId == asset.AssetId)
                    .OrderBy(reference => reference.SourceKind)
                    .OrderBy(reference => reference.SourceKey)
                    .Take(ReferenceSummaryLimit)
                    .ToListAsync(cancellationToken);
                outcome = new AssetDeleteOutcome(
                    AssetDeleteResult.Referenced,
                    new AssetDeleteReferenceSummary(
                        sourceCount,
                        [.. references.Select(static reference => new AssetDeleteReferenceLocation(
                            reference.SourceKind,
                            reference.SourceKey,
                            reference.ArticleId,
                            reference.ReferenceCount))]));
                return;
            }

            if (!string.Equals(asset.StorageClass, "public", StringComparison.Ordinal)
                || !AssetStorageKey.TryParse(asset.StorageKey, out AssetStorageKey storageKey))
            {
                throw new InvalidOperationException($"content_asset_storage_record_invalid:{asset.AssetId}");
            }

            if (!TryResolveStoragePath(_publicRoot, storageKey.Value, out string candidate))
            {
                throw new InvalidOperationException($"content_asset_storage_escape:{asset.AssetId}");
            }

            DateTime now = DateTime.UtcNow;
            await db.Updateable<ContentAsset>()
                .SetColumns(item => new ContentAsset
                {
                    State = ContentAssetStates.PendingDelete,
                    UpdatedAtUtc = now
                })
                .Where(item => item.AssetId == assetId.Value)
                .ExecuteCommandAsync(cancellationToken);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO content_asset_cleanup_queue
                    (asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
                VALUES (@AssetId, @NowUtc, 0, @Marker, @NowUtc)
                ON CONFLICT (asset_id) DO UPDATE
                SET last_error = EXCLUDED.last_error,
                    updated_at_utc = EXCLUDED.updated_at_utc;
                """,
                new SugarParameter("@AssetId", assetId.Value),
                new SugarParameter("@NowUtc", now),
                new SugarParameter("@Marker", ContentAssetCleanupMarkers.DeletePending));
            deletionPath = candidate;
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException($"content_asset_delete_prepare_failed:{assetId}", transaction.ErrorException);
        }

        if (deletionPath is null)
        {
            return outcome;
        }

        cancellationToken.ThrowIfCancellationRequested();
        File.Delete(deletionPath);

        var finalize = await db.Ado.UseTranAsync(async () =>
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                "SELECT pg_advisory_xact_lock(hashtextextended(CAST(@AssetId AS text), 1779));",
                new SugarParameter("@AssetId", assetId.Value)).ConfigureAwait(false);
            bool referenced = await db.Queryable<ContentAssetReference>()
                .Where(reference => reference.AssetId == assetId.Value)
                .AnyAsync(cancellationToken);
            if (referenced)
            {
                throw new InvalidOperationException("content_asset_reference_appeared_during_delete");
            }

            await db.Deleteable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == assetId.Value)
                .ExecuteCommandAsync(cancellationToken);
            int deleted = await db.Deleteable<ContentAsset>()
                .Where(item => item.AssetId == assetId.Value
                    && item.State == ContentAssetStates.PendingDelete)
                .ExecuteCommandAsync(cancellationToken);
            if (deleted == 0 && await db.Queryable<ContentAsset>()
                .Where(item => item.AssetId == assetId.Value)
                .AnyAsync(cancellationToken))
            {
                throw new InvalidOperationException("content_asset_delete_finalize_state_changed");
            }
            outcome = new AssetDeleteOutcome(AssetDeleteResult.Deleted);
        }).ConfigureAwait(false);

        if (!finalize.IsSuccess)
        {
            throw new InvalidOperationException($"content_asset_delete_finalize_failed:{assetId}", finalize.ErrorException);
        }

        logger.LogInformation("content-asset-deleted {AssetId} {Outcome}", assetId, outcome);
        return outcome;
    }

    internal static bool TryResolveStoragePath(
        string rootDirectory,
        string? relativeStorageKey,
        out string candidatePath)
    {
        candidatePath = string.Empty;
        if (string.IsNullOrWhiteSpace(rootDirectory)
            || string.IsNullOrWhiteSpace(relativeStorageKey)
            || Path.IsPathRooted(relativeStorageKey)
            || relativeStorageKey is "." or "..")
        {
            return false;
        }

        try
        {
            string root = Path.GetFullPath(rootDirectory);
            string candidate = Path.GetFullPath(Path.Combine(
                root,
                relativeStorageKey.Replace('/', Path.DirectorySeparatorChar)));
            string relative = Path.GetRelativePath(root, candidate);
            if (relative is "." or ".."
                || Path.IsPathRooted(relative)
                || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
            {
                return false;
            }

            candidatePath = candidate;
            return true;
        }
        catch (Exception exception) when (exception is
            ArgumentException or
            IOException or
            NotSupportedException)
        {
            candidatePath = string.Empty;
            return false;
        }
    }
}
