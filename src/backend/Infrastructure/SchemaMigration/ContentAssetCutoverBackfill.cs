using System.Data;
using System.Security.Cryptography;

using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Helpers;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Services.Articles;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

internal sealed record ContentAssetCutoverBackfillStep : SchemaMigrationStep
{
    internal override string Kind => "ContentAssetCutoverBackfill";
    internal override string Fingerprint => "asset-id-v1:files+article+draft+revision:fail-closed";
    internal override SchemaMigrationCommand? BuildCommand(ISchemaDdlProvider ddl) => null;
}

internal static class ContentAssetCutoverBackfill
{
    private const string PublicPrefix = "/uploads/";

    internal static async Task ExecuteAsync(
        ISqlSugarClient db,
        ReleaseStoragePaths storagePaths,
        CancellationToken cancellationToken)
    {
        string publicRoot = Path.GetFullPath(storagePaths.PublicAssetRoot);
        var urlCodec = new PublicAssetUrlCodec();
        var requiredUrls = new HashSet<string>(StringComparer.Ordinal);
        var legacyHashes = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var legacyCleanup = new Dictionary<string, LegacyCleanup>(StringComparer.Ordinal);
        var prototypeAssetsByStorageKey = new Dictionary<string, ContentAsset>(StringComparer.Ordinal);
        var sources = new List<SourceSnapshot>();
        var failures = new List<string>();

        List<ContentAsset> prototypeAssets = await db.Queryable<ContentAsset>()
            .ToListAsync(cancellationToken);
        Dictionary<Guid, ContentAsset> prototypeAssetsById = prototypeAssets
            .ToDictionary(static asset => asset.AssetId);
        foreach (ContentAsset prototype in prototypeAssets)
        {
            if (!string.Equals(prototype.StorageClass, "public", StringComparison.Ordinal)
                || !AssetStorageKey.TryParse(prototype.StorageKey, out AssetStorageKey storageKey))
            {
                failures.Add($"invalid_prototype_asset:{prototype.AssetId}");
                continue;
            }

            string publicUrl = PublicPrefix + storageKey.Value;
            requiredUrls.Add(publicUrl);
            prototypeAssetsByStorageKey.Add(storageKey.Value, prototype);
            if (!string.IsNullOrWhiteSpace(prototype.Sha256))
            {
                legacyHashes[publicUrl] = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
                {
                    prototype.Sha256
                };
            }
        }

        foreach (ContentAssetCleanupQueueItem prototypeCleanup in
            await db.Queryable<ContentAssetCleanupQueueItem>().ToListAsync(cancellationToken))
        {
            if (!prototypeAssetsById.TryGetValue(prototypeCleanup.AssetId, out ContentAsset? prototype))
            {
                failures.Add($"orphan_prototype_cleanup:{prototypeCleanup.AssetId}");
                continue;
            }

            legacyCleanup[PublicPrefix + prototype.StorageKey] = new LegacyCleanup(
                prototypeCleanup.NotBeforeUtc,
                prototypeCleanup.AttemptCount,
                prototypeCleanup.LastError,
                prototypeCleanup.UpdatedAtUtc);
        }

        List<Article> articles = await db.Queryable<Article>().ClearFilter().ToListAsync(cancellationToken);
        Dictionary<int, string> bodies = (await db.Queryable<ArticleBody>().ToListAsync(cancellationToken))
            .ToDictionary(static body => body.ArticleId, static body => body.MarkdownContent);
        foreach (Article article in articles)
        {
            AddSource(
                ContentAssetSourceKinds.Article,
                article.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                article.Id,
                bodies.GetValueOrDefault(article.Id, string.Empty),
                article.CoverImageUrl);
        }

        foreach (ArticleDraft draft in await db.Queryable<ArticleDraft>().ToListAsync(cancellationToken))
        {
            AddSource(
                ContentAssetSourceKinds.Draft,
                $"{draft.OwnerAdminPrincipalId}:{draft.DraftKey}",
                draft.ArticleId,
                draft.MarkdownContent,
                draft.CoverImageUrl);
        }

        List<ArticleRevision> revisions = await db.Queryable<ArticleRevision>().ToListAsync(cancellationToken);
        await ArticleRevisionContentBlockStore.HydrateAsync(db, revisions, cancellationToken).ConfigureAwait(false);
        foreach (ArticleRevision revision in revisions)
        {
            AddSource(
                ContentAssetSourceKinds.Revision,
                revision.Id.ToString(System.Globalization.CultureInfo.InvariantCulture),
                revision.ArticleId,
                revision.MarkdownContent,
                revision.CoverImageUrl);
        }

        await AddLegacyUrlsAsync(db, requiredUrls, legacyHashes, legacyCleanup, cancellationToken).ConfigureAwait(false);
        if (Directory.Exists(publicRoot))
        {
            foreach (string file in Directory.EnumerateFiles(publicRoot, "*", SearchOption.AllDirectories))
            {
                cancellationToken.ThrowIfCancellationRequested();
                string relative = Path.GetRelativePath(publicRoot, file).Replace(Path.DirectorySeparatorChar, '/');
                if (AssetStorageKey.TryParse(relative, out _))
                {
                    requiredUrls.Add(PublicPrefix + relative);
                }
            }
        }

        var assetsByStorageKey = new Dictionary<string, ContentAsset>(StringComparer.Ordinal);
        foreach (string publicUrl in requiredUrls.Order(StringComparer.Ordinal))
        {
            if (!urlCodec.TryGetStorageKey(publicUrl, out AssetStorageKey storageKey))
            {
                failures.Add($"unrecognized_url:{publicUrl}");
                continue;
            }

            string path = ResolvePath(publicRoot, storageKey);
            if (!File.Exists(path))
            {
                failures.Add($"missing_file:{publicUrl}");
                continue;
            }

            byte[] bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
            string sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (legacyHashes.TryGetValue(publicUrl, out HashSet<string>? expected)
                && expected.Any(hash => !string.Equals(hash, sha256, StringComparison.OrdinalIgnoreCase)))
            {
                failures.Add($"hash_conflict:{publicUrl}:{string.Join(',', expected.Order(StringComparer.Ordinal))}:{sha256}");
                continue;
            }

            string extension = Path.GetExtension(storageKey.Value).ToLowerInvariant();
            if (!ContentAssetMediaInspector.TryInspect(extension, bytes, out ContentAssetMediaMetadata media))
            {
                failures.Add($"unrecognized_media:{publicUrl}");
                continue;
            }

            prototypeAssetsByStorageKey.TryGetValue(storageKey.Value, out ContentAsset? prototype);
            string fileStem = Path.GetFileNameWithoutExtension(storageKey.Value);
            Guid assetId = prototype?.AssetId
                ?? (TryParseFileNameAssetId(fileStem, out AssetId parsed) ? parsed.Value : AssetId.New().Value);
            assetsByStorageKey.Add(storageKey.Value, new ContentAsset
            {
                AssetId = assetId,
                StorageClass = "public",
                StorageKey = storageKey.Value,
                MimeType = media.MediaType,
                Extension = extension,
                SizeBytes = bytes.LongLength,
                Sha256 = sha256,
                WidthPixels = media.Width,
                HeightPixels = media.Height,
                OwnerAdminPrincipalId = prototype?.OwnerAdminPrincipalId,
                State = ContentAssetStates.Active,
                CreatedAtUtc = prototype is null ? DateTime.UtcNow : AsUtc(prototype.CreatedAtUtc),
                UpdatedAtUtc = DateTime.UtcNow
            });
        }

        if (failures.Count > 0)
        {
            throw new InvalidOperationException("content_asset_cutover_blocked:" + string.Join(';', failures.Order(StringComparer.Ordinal)));
        }

        await db.Deleteable<ContentAssetCleanupQueueItem>().ExecuteCommandAsync(cancellationToken);
        await db.Deleteable<ContentAssetReference>().ExecuteCommandAsync(cancellationToken);
        await db.Deleteable<ContentAsset>().ExecuteCommandAsync(cancellationToken);
        if (assetsByStorageKey.Count > 0)
        {
            await db.Insertable(assetsByStorageKey.Values.OrderBy(static asset => asset.StorageKey).ToArray())
                .ExecuteCommandAsync(cancellationToken);
        }

        DateTime now = DateTime.UtcNow;
        foreach ((string publicUrl, LegacyCleanup cleanup) in legacyCleanup.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            AssetStorageKey storageKey = AssetStorageKey.Parse(publicUrl[PublicPrefix.Length..]);
            ContentAsset asset = assetsByStorageKey[storageKey.Value];
            asset.State = ContentAssetStates.PendingDelete;
            await db.Updateable<ContentAsset>()
                .SetColumns(item => new ContentAsset { State = ContentAssetStates.PendingDelete, UpdatedAtUtc = now })
                .Where(item => item.AssetId == asset.AssetId)
                .ExecuteCommandAsync(cancellationToken);
            await db.Insertable(new ContentAssetCleanupQueueItem
            {
                AssetId = asset.AssetId,
                NotBeforeUtc = AsUtc(cleanup.NotBeforeUtc),
                AttemptCount = cleanup.AttemptCount,
                LastError = cleanup.LastError,
                UpdatedAtUtc = AsUtc(cleanup.UpdatedAtUtc)
            }).ExecuteCommandAsync(cancellationToken);
        }

        foreach (SourceSnapshot source in sources)
        {
            Dictionary<string, ReferenceAggregate> references = BuildReferences(source.Markdown, source.CoverUrl, urlCodec);
            foreach ((string storageKey, ReferenceAggregate reference) in references.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
            {
                ContentAsset asset = assetsByStorageKey[storageKey];
                await db.Insertable(new ContentAssetReference
                {
                    AssetId = asset.AssetId,
                    SourceKind = source.Kind,
                    SourceKey = source.Key,
                    ArticleId = source.ArticleId,
                    ReferenceCount = reference.Count,
                    AltText = reference.AltText,
                    UpdatedAtUtc = now
                }).ExecuteCommandAsync(cancellationToken);
            }
        }

        await db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM content_asset_cleanup_queue queue
            WHERE EXISTS (
                SELECT 1 FROM content_asset_reference reference
                WHERE reference.asset_id = queue.asset_id
            );

            UPDATE content_asset asset
            SET state = 'active', updated_at_utc = @UpdatedAtUtc
            WHERE EXISTS (
                SELECT 1 FROM content_asset_reference reference
                WHERE reference.asset_id = asset.id
            );
            """,
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);

        void AddSource(string kind, string key, int? articleId, string markdown, string? coverUrl)
        {
            sources.Add(new SourceSnapshot(kind, key, articleId, markdown, coverUrl));
            foreach (string url in EnumerateUrls(markdown, coverUrl))
            {
                requiredUrls.Add(url);
            }
        }
    }

    private static async Task AddLegacyUrlsAsync(
        ISqlSugarClient db,
        HashSet<string> urls,
        Dictionary<string, HashSet<string>> hashes,
        Dictionary<string, LegacyCleanup> cleanup,
        CancellationToken cancellationToken)
    {
        string assetTable = "asset_library_" + "item";
        if (await TableExistsAsync(db, assetTable).ConfigureAwait(false))
        {
            using var reader = (System.Data.Common.DbDataReader)await db.Ado.GetDataReaderAsync(
                $"SELECT url, sha256 FROM {assetTable};");
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                string url = reader.ReadString("url");
                urls.Add(url);
                if (!reader.IsNull("sha256"))
                {
                    if (!hashes.TryGetValue(url, out HashSet<string>? values))
                    {
                        values = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                        hashes[url] = values;
                    }
                    values.Add(reader.ReadString("sha256"));
                }
            }
        }

        string cleanupTable = "article_asset_" + "cleanup_queue";
        if (await TableExistsAsync(db, cleanupTable).ConfigureAwait(false))
        {
            using var reader = (System.Data.Common.DbDataReader)await db.Ado.GetDataReaderAsync(
                $"SELECT normalized_url, not_before_utc, attempt_count, last_error, updated_at_utc FROM {cleanupTable};");
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                string url = reader.ReadString("normalized_url");
                urls.Add(url);
                cleanup[url] = new LegacyCleanup(
                    reader.ReadDateTime("not_before_utc"),
                    reader.ReadInt32("attempt_count"),
                    reader.IsNull("last_error") ? null : reader.ReadString("last_error"),
                    reader.ReadDateTime("updated_at_utc"));
            }
        }

        foreach ((string table, string column) in new[]
        {
            ("article_asset_" + "reference", "normalized_url"),
            ("asset_library_" + "article_ref", "url")
        })
        {
            if (!await TableExistsAsync(db, table).ConfigureAwait(false))
            {
                continue;
            }

            DataTable data = await db.Ado.GetDataTableAsync($"SELECT DISTINCT {column} AS public_url FROM {table};");
            foreach (DataRow row in data.Rows)
            {
                if (Convert.ToString(row["public_url"]) is { Length: > 0 } url)
                {
                    urls.Add(url);
                }
            }
        }
    }

    private static async Task<bool> TableExistsAsync(ISqlSugarClient db, string table)
    {
        object result = await db.Ado.GetScalarAsync(
            "SELECT to_regclass(@TableName) IS NOT NULL;",
            new SugarParameter("@TableName", "public." + table));
        return Convert.ToBoolean(result);
    }

    private static Dictionary<string, ReferenceAggregate> BuildReferences(
        string markdown,
        string? coverUrl,
        PublicAssetUrlCodec codec)
    {
        var result = new Dictionary<string, ReferenceAggregate>(StringComparer.Ordinal);
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdown ?? string.Empty))
        {
            Add(reference.Url, reference.AltText, CountOccurrences(markdown, reference.Url));
        }
        Add(coverUrl, null, 1);
        return result;

        void Add(string? url, string? altText, int count)
        {
            if (string.IsNullOrWhiteSpace(url) || count <= 0)
            {
                return;
            }
            if (!codec.TryGetStorageKey(url, out AssetStorageKey key))
            {
                throw new InvalidOperationException($"content_asset_cutover_unrecognized_url:{url}");
            }
            result.TryGetValue(key.Value, out ReferenceAggregate? existing);
            result[key.Value] = existing is null
                ? new ReferenceAggregate(count, NormalizeAltText(altText))
                : existing with
                {
                    Count = existing.Count + count,
                    AltText = existing.AltText ?? NormalizeAltText(altText)
                };
        }
    }

    private static IEnumerable<string> EnumerateUrls(string markdown, string? coverUrl)
    {
        foreach (ImageHelper.IllustrationReference reference in ImageHelper.ExtractIllustrationReferences(markdown ?? string.Empty))
        {
            yield return reference.Url;
        }
        if (!string.IsNullOrWhiteSpace(coverUrl) && coverUrl.StartsWith(PublicPrefix, StringComparison.Ordinal))
        {
            yield return coverUrl;
        }
    }

    private static string ResolvePath(string root, AssetStorageKey storageKey)
    {
        string normalizedRoot = Path.GetFullPath(root);
        string path = Path.GetFullPath(Path.Combine(
            normalizedRoot,
            storageKey.Value.Replace('/', Path.DirectorySeparatorChar)));
        string relative = Path.GetRelativePath(normalizedRoot, path);
        if (relative is "." or ".."
            || Path.IsPathRooted(relative)
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"content_asset_cutover_storage_escape:{storageKey}");
        }
        return path;
    }

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

    private static DateTime AsUtc(DateTime value)
        => value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private static bool TryParseFileNameAssetId(string value, out AssetId assetId)
    {
        if (Guid.TryParseExact(value, "N", out Guid compact))
        {
            assetId = AssetId.FromGuid(compact);
            return true;
        }

        return AssetId.TryParse(value, out assetId);
    }

    private sealed record SourceSnapshot(string Kind, string Key, int? ArticleId, string Markdown, string? CoverUrl);
    private sealed record ReferenceAggregate(int Count, string? AltText);
    private sealed record LegacyCleanup(DateTime NotBeforeUtc, int AttemptCount, string? LastError, DateTime UpdatedAtUtc);
}
