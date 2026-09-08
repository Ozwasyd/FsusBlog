using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed class LocalContentAssetStore(
    ISqlSugarClient db,
    ReleaseStoragePaths storagePaths,
    IPrivateAssetStore privateAssetStore,
    ILogger<LocalContentAssetStore> logger) : IAssetStore
{
    private const int ReferenceSummaryLimit = 16;

    private readonly string _publicRoot = Path.GetFullPath(storagePaths.PublicAssetRoot);

    public async Task<AssetDeleteOutcome> DeleteAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        AssetDeleteOutcome outcome = new(AssetDeleteResult.NotFound);
        ContentAsset? deletion = null;
        var prepare = await db.Ado.UseTranAsync(async () =>
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

            if (!AssetStorageKey.TryParse(asset.StorageKey, out AssetStorageKey storageKey))
            {
                throw new InvalidOperationException($"content_asset_storage_record_invalid:{asset.AssetId}");
            }

            if (!string.Equals(asset.StorageClass, "private", StringComparison.Ordinal)
                && !string.Equals(asset.StorageClass, "public", StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"content_asset_storage_record_invalid:{asset.AssetId}");
            }

            if (string.Equals(asset.StorageClass, "public", StringComparison.Ordinal)
                && !TryResolveStoragePath(_publicRoot, storageKey.Value, out _))
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
                .Where(item => item.AssetId == asset.AssetId)
                .ExecuteCommandAsync(cancellationToken);
            await db.Ado.ExecuteCommandAsync(
                """
                INSERT INTO content_asset_cleanup_queue
                    (asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
                VALUES
                    (@AssetId, @NotBeforeUtc, 0, @Marker, @UpdatedAtUtc)
                ON CONFLICT (asset_id) DO UPDATE
                SET not_before_utc = LEAST(content_asset_cleanup_queue.not_before_utc, EXCLUDED.not_before_utc),
                    last_error = EXCLUDED.last_error,
                    updated_at_utc = EXCLUDED.updated_at_utc;
                """,
                new SugarParameter("@AssetId", asset.AssetId),
                new SugarParameter("@NotBeforeUtc", now),
                new SugarParameter("@Marker", ContentAssetCleanupMarkers.DeletePending),
                new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
            deletion = asset;
        }).ConfigureAwait(false);

        if (!prepare.IsSuccess)
        {
            throw new InvalidOperationException("content_asset_delete_prepare_failed", prepare.ErrorException);
        }

        if (deletion is null)
        {
            logger.LogInformation("content-asset-deleted {AssetId} {Outcome}", assetId, outcome);
            return outcome;
        }

        try
        {
            if (string.Equals(deletion.StorageClass, "private", StringComparison.Ordinal))
            {
                await privateAssetStore.DeleteAsync(assetId, cancellationToken).ConfigureAwait(false);
            }
            else if (TryResolveStoragePath(_publicRoot, deletion.StorageKey, out string publicPath))
            {
                File.Delete(publicPath);
            }
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new InvalidOperationException("content_asset_byte_delete_failed");
        }

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
            throw new InvalidOperationException("content_asset_delete_finalize_failed", finalize.ErrorException);
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
