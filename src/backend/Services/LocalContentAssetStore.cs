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
    private readonly string _publicRoot = Path.GetFullPath(storagePaths.PublicAssetRoot);

    public async Task<AssetDeleteResult> DeleteAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        AssetDeleteResult outcome = AssetDeleteResult.NotFound;
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
                outcome = AssetDeleteResult.NotFound;
                return;
            }

            bool referenced = await db.Queryable<ContentAssetReference>()
                .Where(reference => reference.AssetId == asset.AssetId)
                .AnyAsync(cancellationToken);
            if (referenced)
            {
                outcome = AssetDeleteResult.Referenced;
                return;
            }

            if (!AssetStorageKey.TryParse(asset.StorageKey, out AssetStorageKey storageKey))
            {
                throw new InvalidOperationException($"content_asset_storage_record_invalid:{asset.AssetId}");
            }

            if (string.Equals(asset.StorageClass, "private", StringComparison.Ordinal))
            {
                await privateAssetStore.DeleteAsync(assetId, cancellationToken).ConfigureAwait(false);
            }
            else if (string.Equals(asset.StorageClass, "public", StringComparison.Ordinal))
            {
                if (!TryResolveStoragePath(_publicRoot, storageKey.Value, out string candidate))
                {
                    throw new InvalidOperationException($"content_asset_storage_escape:{asset.AssetId}");
                }

                if (File.Exists(candidate))
                {
                    File.Delete(candidate);
                }
            }
            else
            {
                throw new InvalidOperationException($"content_asset_storage_record_invalid:{asset.AssetId}");
            }

            await db.Deleteable<ContentAssetCleanupQueueItem>()
                .Where(item => item.AssetId == asset.AssetId)
                .ExecuteCommandAsync(cancellationToken);
            await db.Deleteable<ContentAsset>()
                .Where(item => item.AssetId == asset.AssetId)
                .ExecuteCommandAsync(cancellationToken);
            outcome = AssetDeleteResult.Deleted;
        }).ConfigureAwait(false);

        if (!transaction.IsSuccess)
        {
            throw new InvalidOperationException($"content_asset_delete_failed:{assetId}", transaction.ErrorException);
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
