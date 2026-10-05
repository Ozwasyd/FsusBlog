using System.Buffers.Binary;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using SqlSugar;

namespace FsusBlog.Migration;

/// <summary>
/// Performs the one-shot URL-to-AssetId conversion while the cutover descriptor
/// transaction is still open.  The migration host owns this code so a Server
/// process can never accidentally execute a destructive backfill during startup.
/// </summary>
internal static partial class ContentAssetCutoverBackfill
{
    private const string PublicPrefix = "/uploads/";
    private const string PublicStorageClass = "public";
    private const string ActiveState = "active";
    private const string PendingDeleteState = "pending_delete";

    internal static async Task ExecuteAsync(
        ISqlSugarClient db,
        string publicAssetRoot,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(db);
        cancellationToken.ThrowIfCancellationRequested();

        string root = NormalizeRoot(publicAssetRoot);
        var failures = new List<string>();
        var requiredUrls = new HashSet<string>(StringComparer.Ordinal);
        var legacyHashes = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        var legacyCleanup = new Dictionary<string, LegacyCleanup>(StringComparer.Ordinal);
        var legacyOwnership = new List<LegacyOwnershipClaim>();
        var preservedAssets = new List<MaterializedAsset>();
        var preservedCleanup = new Dictionary<Guid, LegacyCleanup>();
        var preservedReferences = new List<CanonicalReference>();
        var prototypeByStorageKey = new Dictionary<string, PrototypeAsset>(StringComparer.Ordinal);
        var prototypeById = new Dictionary<Guid, PrototypeAsset>();
        var sources = new List<SourceSnapshot>();
        var sourceByIdentity = new Dictionary<SourceIdentity, SourceSnapshot>();
        var referencesBySource = new Dictionary<SourceIdentity, IReadOnlyDictionary<string, ReferenceAggregate>>();
        DateTime now = DateTime.UtcNow;

        await ReadPrototypeAssetsAsync(
            db,
            prototypeByStorageKey,
            prototypeById,
            preservedAssets,
            requiredUrls,
            legacyHashes,
            failures,
            cancellationToken).ConfigureAwait(false);
        await ReadPrototypeCleanupAsync(
            db,
            prototypeById,
            preservedCleanup,
            legacyCleanup,
            failures,
            cancellationToken).ConfigureAwait(false);
        await ReadPreservedCanonicalReferencesAsync(
            db,
            prototypeById,
            preservedReferences,
            failures,
            cancellationToken).ConfigureAwait(false);

        await ReadCurrentSourcesAsync(
            db,
            sources,
            sourceByIdentity,
            requiredUrls,
            failures,
            cancellationToken).ConfigureAwait(false);
        await ReadLegacyStateAsync(
            db,
            requiredUrls,
            legacyHashes,
            legacyCleanup,
            legacyOwnership,
            failures,
            cancellationToken).ConfigureAwait(false);

        foreach (SourceSnapshot source in sources)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryBuildReferences(
                    source.Markdown,
                    source.CoverUrl,
                    out Dictionary<string, ReferenceAggregate>? references,
                    out string? referenceFailure))
            {
                failures.Add($"source_reference_invalid:{source.Identity.Kind}:{source.Identity.Key}:{referenceFailure}");
                continue;
            }

            referencesBySource.Add(source.Identity, references);
            foreach (string storageKey in references.Keys)
            {
                requiredUrls.Add(PublicPrefix + storageKey);
            }
        }

        ValidateLegacyOwnership(
            legacyOwnership,
            sourceByIdentity,
            referencesBySource,
            failures);

        EnumeratePublicFiles(root, requiredUrls, failures, cancellationToken);

        var assetsByStorageKey = new Dictionary<string, MaterializedAsset>(StringComparer.Ordinal);
        var assetsById = new Dictionary<Guid, MaterializedAsset>();
        foreach (MaterializedAsset preserved in preservedAssets)
        {
            if (!assetsById.TryAdd(preserved.AssetId, preserved)
                || !assetsByStorageKey.TryAdd(preserved.StorageKey, preserved))
            {
                failures.Add($"duplicate_preserved_asset:{preserved.AssetId:D}:{preserved.StorageKey}");
            }
        }
        foreach (string publicUrl in requiredUrls.Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!TryGetStorageKey(publicUrl, out string storageKey))
            {
                failures.Add($"unrecognized_url:{publicUrl}");
                continue;
            }

            string path;
            try
            {
                path = ResolvePath(root, storageKey);
            }
            catch (InvalidOperationException)
            {
                failures.Add($"storage_escape:{publicUrl}");
                continue;
            }

            if (!File.Exists(path))
            {
                failures.Add($"missing_file:{publicUrl}");
                continue;
            }

            if (!IsRegularFile(path))
            {
                failures.Add($"unsafe_file:{publicUrl}");
                continue;
            }

            byte[] bytes;
            try
            {
                bytes = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                failures.Add($"read_file_failed:{publicUrl}:{exception.GetType().Name}");
                continue;
            }

            string sha256 = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (legacyHashes.TryGetValue(publicUrl, out HashSet<string>? expectedHashes)
                && expectedHashes.Any(expected => !string.Equals(expected, sha256, StringComparison.OrdinalIgnoreCase)))
            {
                failures.Add($"hash_conflict:{publicUrl}:{string.Join(',', expectedHashes.Order(StringComparer.Ordinal))}:{sha256}");
                continue;
            }

            string extension = Path.GetExtension(storageKey).ToLowerInvariant();
            if (!MigrationMediaInspector.TryInspect(extension, bytes, out MigrationMediaMetadata media))
            {
                failures.Add($"unrecognized_media:{publicUrl}");
                continue;
            }

            prototypeByStorageKey.TryGetValue(storageKey, out PrototypeAsset? prototype);
            ValidatePrototypeMetadata(prototype, media, extension, bytes.LongLength, publicUrl, failures);

            Guid assetId = prototype?.AssetId
                ?? (TryParseFileNameAssetId(Path.GetFileNameWithoutExtension(storageKey), out Guid parsed)
                    ? parsed
                    : CreateDeterministicAssetId(storageKey, sha256));
            if (assetId == Guid.Empty)
            {
                failures.Add($"empty_asset_id:{publicUrl}");
                continue;
            }

            var asset = new MaterializedAsset(
                assetId,
                PublicStorageClass,
                storageKey,
                media.MediaType,
                extension,
                bytes.LongLength,
                sha256,
                media.Width,
                media.Height,
                prototype?.OwnerAdminPrincipalId,
                legacyCleanup.ContainsKey(publicUrl) || prototype?.State is PendingDeleteState
                    ? PendingDeleteState
                    : ActiveState,
                prototype is null ? now : AsUtc(prototype.CreatedAtUtc),
                now);

            if (assetsByStorageKey.ContainsKey(storageKey))
            {
                failures.Add($"duplicate_storage_key:{storageKey}");
                continue;
            }

            if (assetsById.TryGetValue(asset.AssetId, out MaterializedAsset? existing)
                && !string.Equals(existing.StorageKey, asset.StorageKey, StringComparison.Ordinal))
            {
                failures.Add($"asset_id_conflict:{asset.AssetId:D}:{existing.StorageKey}:{asset.StorageKey}");
                continue;
            }

            assetsByStorageKey.Add(storageKey, asset);
            assetsById.TryAdd(asset.AssetId, asset);
        }

        foreach ((string publicUrl, LegacyCleanup cleanup) in legacyCleanup)
        {
            if (!TryGetStorageKey(publicUrl, out string storageKey)
                || !assetsByStorageKey.ContainsKey(storageKey))
            {
                failures.Add($"cleanup_asset_missing:{publicUrl}");
            }
            else if (cleanup.AttemptCount < 0)
            {
                failures.Add($"cleanup_attempt_invalid:{publicUrl}");
            }
        }

        if (failures.Count > 0)
        {
            throw new InvalidOperationException(
                "content_asset_cutover_blocked:" + string.Join(';', failures.Order(StringComparer.Ordinal)));
        }

        foreach ((SourceIdentity identity, IReadOnlyDictionary<string, ReferenceAggregate> references) in referencesBySource)
        {
            foreach (string storageKey in references.Keys)
            {
                if (!assetsByStorageKey.ContainsKey(storageKey))
                {
                    throw new InvalidOperationException(
                        $"content_asset_cutover_reference_asset_missing:{identity.Kind}:{identity.Key}:{storageKey}");
                }
            }
        }

        await WriteCanonicalStateAsync(
            db,
            assetsByStorageKey,
            legacyCleanup,
            preservedCleanup,
            preservedReferences,
            sourceByIdentity,
            referencesBySource,
            now,
            cancellationToken).ConfigureAwait(false);
    }

    private static async Task ReadPrototypeAssetsAsync(
        ISqlSugarClient db,
        Dictionary<string, PrototypeAsset> byStorageKey,
        Dictionary<Guid, PrototypeAsset> byId,
        List<MaterializedAsset> preservedAssets,
        HashSet<string> requiredUrls,
        Dictionary<string, HashSet<string>> hashes,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(db, "content_asset", cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        var storageKeys = new HashSet<string>(StringComparer.Ordinal);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id, storage_class, storage_key, media_type, extension, byte_length,
                   sha256, width, height, owner_admin_principal_id, state,
                   created_at_utc, updated_at_utc
            FROM content_asset;
            """).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!TryReadGuid(reader, "id", out Guid assetId) || assetId == Guid.Empty)
            {
                failures.Add("invalid_prototype_asset_id");
                continue;
            }

            var prototype = new PrototypeAsset(
                assetId,
                ReadString(reader, "storage_class"),
                ReadString(reader, "storage_key"),
                ReadString(reader, "media_type"),
                ReadString(reader, "extension"),
                ReadInt64(reader, "byte_length"),
                ReadNullableString(reader, "sha256"),
                ReadNullableInt32(reader, "width"),
                ReadNullableInt32(reader, "height"),
                ReadNullableInt64(reader, "owner_admin_principal_id"),
                ReadString(reader, "state"),
                ReadDateTime(reader, "created_at_utc"),
                ReadDateTime(reader, "updated_at_utc"));

            if (!TryParseStorageKey(prototype.StorageKey, out string storageKey)
                || !IsValidStorageClass(prototype.StorageClass)
                || !IsValidState(prototype.State))
            {
                failures.Add($"invalid_prototype_asset:{assetId:D}");
                continue;
            }

            if (byId.ContainsKey(assetId))
            {
                failures.Add($"duplicate_prototype_asset_id:{assetId:D}");
                continue;
            }

            string publicUrl = PublicPrefix + storageKey;
            if (!storageKeys.Add(storageKey))
            {
                failures.Add($"duplicate_prototype_storage_key:{storageKey}");
                continue;
            }

            PrototypeAsset normalizedPrototype = prototype with
            {
                StorageKey = storageKey
            };
            byId.Add(assetId, normalizedPrototype);
            if (string.Equals(prototype.StorageClass, PublicStorageClass, StringComparison.Ordinal)
                && IsCutoverStorageKey(storageKey))
            {
                byStorageKey.Add(storageKey, normalizedPrototype);
                requiredUrls.Add(publicUrl);
                AddLegacyHash(publicUrl, prototype.Sha256, hashes, failures);
            }
            else
            {
                preservedAssets.Add(ToMaterializedAsset(normalizedPrototype));
            }
        }
    }

    private static async Task ReadPrototypeCleanupAsync(
        ISqlSugarClient db,
        IReadOnlyDictionary<Guid, PrototypeAsset> prototypes,
        Dictionary<Guid, LegacyCleanup> preservedCleanup,
        Dictionary<string, LegacyCleanup> cleanupByUrl,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(db, "content_asset_cleanup_queue", cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT queue.asset_id, asset.storage_key, queue.not_before_utc,
                   queue.attempt_count, queue.last_error, queue.updated_at_utc
            FROM content_asset_cleanup_queue queue
            LEFT JOIN content_asset asset ON asset.id = queue.asset_id;
            """).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!TryReadGuid(reader, "asset_id", out Guid assetId)
                || !prototypes.TryGetValue(assetId, out PrototypeAsset? prototype)
                || !TryParseStorageKey(ReadNullableString(reader, "storage_key"), out string storageKey))
            {
                failures.Add($"orphan_prototype_cleanup:{assetId:D}");
                continue;
            }

            LegacyCleanup value = new(
                ReadDateTime(reader, "not_before_utc"),
                ReadInt32(reader, "attempt_count"),
                ReadNullableString(reader, "last_error"),
                ReadDateTime(reader, "updated_at_utc"));
            if (!string.Equals(prototype.StorageClass, PublicStorageClass, StringComparison.Ordinal)
                || !IsCutoverStorageKey(storageKey))
            {
                if (preservedCleanup.TryGetValue(assetId, out LegacyCleanup? existing)
                    && existing != value)
                {
                    failures.Add($"cleanup_conflict:{assetId:D}:prototype");
                }
                else
                {
                    preservedCleanup[assetId] = value;
                }
                continue;
            }

            AddCleanup(
                PublicPrefix + storageKey,
                value,
                cleanupByUrl,
                failures,
                "prototype");
        }
    }

    private static async Task ReadCurrentSourcesAsync(
        ISqlSugarClient db,
        List<SourceSnapshot> sources,
        Dictionary<SourceIdentity, SourceSnapshot> sourceByIdentity,
        HashSet<string> requiredUrls,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(db, "article", cancellationToken).ConfigureAwait(false))
        {
            failures.Add("current_article_table_missing");
        }
        else if (!await TableExistsAsync(db, "article_body", cancellationToken).ConfigureAwait(false))
        {
            failures.Add("current_article_body_table_missing");
        }
        else
        {
            using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT article.id, article.coverimageurl AS cover_image_url,
                       COALESCE(body.markdown_content, '') AS markdown_content
                FROM article
                LEFT JOIN article_body body ON body.article_id = article.id;
                """).ConfigureAwait(false);
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                int articleId = ReadInt32(reader, "id");
                AddSource(
                    new SourceSnapshot(
                        new SourceIdentity("article", articleId.ToString(CultureInfo.InvariantCulture)),
                        articleId,
                        ReadString(reader, "markdown_content"),
                        ReadNullableString(reader, "cover_image_url")),
                    sources,
                    sourceByIdentity,
                    requiredUrls,
                    failures);
            }
        }

        if (!await TableExistsAsync(db, "article_draft", cancellationToken).ConfigureAwait(false))
        {
            failures.Add("current_article_draft_table_missing");
        }
        else
        {
            using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT owner_admin_principal_id, draft_key, article_id,
                       markdown_content, cover_image_url
                FROM article_draft;
                """).ConfigureAwait(false);
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                long owner = ReadInt64(reader, "owner_admin_principal_id");
                string draftKey = ReadString(reader, "draft_key");
                AddSource(
                    new SourceSnapshot(
                        new SourceIdentity(
                            "draft",
                            $"{owner.ToString(CultureInfo.InvariantCulture)}:{draftKey}"),
                        ReadNullableInt32(reader, "article_id"),
                        ReadString(reader, "markdown_content"),
                        ReadNullableString(reader, "cover_image_url")),
                    sources,
                    sourceByIdentity,
                    requiredUrls,
                    failures);
            }
        }

        if (!await TableExistsAsync(db, "article_revision", cancellationToken).ConfigureAwait(false))
        {
            failures.Add("current_article_revision_table_missing");
            return;
        }

        if (!await TableExistsAsync(db, "article_revision_content_block", cancellationToken)
                .ConfigureAwait(false))
        {
            failures.Add("current_article_revision_content_block_table_missing");
            return;
        }
        const string RevisionQuery =
            """
            SELECT revision.id, revision.article_id, revision.markdown_content,
                   revision.cover_image_url, revision.content_block_id,
                   block.markdown_content AS block_markdown_content
            FROM article_revision revision
            LEFT JOIN article_revision_content_block block
              ON block.id = revision.content_block_id;
            """;
        using DbDataReader revisionReader = (DbDataReader)await db.Ado.GetDataReaderAsync(RevisionQuery).ConfigureAwait(false);
        while (await revisionReader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            long revisionId = ReadInt64(revisionReader, "id");
            long? contentBlockId = ReadNullableInt64(revisionReader, "content_block_id");
            string? blockMarkdown = ReadNullableString(revisionReader, "block_markdown_content");
            if (contentBlockId is > 0 && blockMarkdown is null)
            {
                failures.Add($"revision_content_block_missing:{revisionId}:{contentBlockId}");
                continue;
            }

            AddSource(
                new SourceSnapshot(
                    new SourceIdentity("revision", revisionId.ToString(CultureInfo.InvariantCulture)),
                    ReadInt32(revisionReader, "article_id"),
                    blockMarkdown ?? ReadString(revisionReader, "markdown_content"),
                    ReadNullableString(revisionReader, "cover_image_url")),
                sources,
                sourceByIdentity,
                requiredUrls,
                failures);
        }
    }

    private static async Task ReadPreservedCanonicalReferencesAsync(
        ISqlSugarClient db,
        IReadOnlyDictionary<Guid, PrototypeAsset> prototypes,
        List<CanonicalReference> preservedReferences,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(db, "content_asset_reference", cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        var identities = new HashSet<CanonicalReferenceIdentity>();
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT asset_id, source_kind, source_key, article_id,
                   reference_count, alt_text, updated_at_utc
            FROM content_asset_reference;
            """).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!TryReadGuid(reader, "asset_id", out Guid assetId)
                || !prototypes.TryGetValue(assetId, out PrototypeAsset? prototype))
            {
                failures.Add($"orphan_canonical_reference:{assetId:D}");
                continue;
            }

            if (string.Equals(prototype.StorageClass, PublicStorageClass, StringComparison.Ordinal)
                && IsCutoverStorageKey(prototype.StorageKey))
            {
                continue;
            }

            string sourceKind = ReadString(reader, "source_kind");
            string sourceKey = ReadString(reader, "source_key");
            int referenceCount = ReadInt32(reader, "reference_count");
            var identity = new CanonicalReferenceIdentity(assetId, sourceKind, sourceKey);
            if (!IsValidSourceKind(sourceKind)
                || sourceKey.Length == 0
                || sourceKey.Length > 160
                || referenceCount <= 0
                || !identities.Add(identity))
            {
                failures.Add($"invalid_preserved_canonical_reference:{assetId:D}:{sourceKind}:{sourceKey}");
                continue;
            }

            preservedReferences.Add(new CanonicalReference(
                assetId,
                sourceKind,
                sourceKey,
                ReadNullableInt32(reader, "article_id"),
                referenceCount,
                NormalizeAltText(ReadNullableString(reader, "alt_text")),
                ReadDateTime(reader, "updated_at_utc")));
        }
    }

    private static async Task ReadLegacyStateAsync(
        ISqlSugarClient db,
        HashSet<string> requiredUrls,
        Dictionary<string, HashSet<string>> hashes,
        Dictionary<string, LegacyCleanup> cleanupByUrl,
        List<LegacyOwnershipClaim> ownership,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        if (await TableExistsAsync(db, "asset_library_item", cancellationToken).ConfigureAwait(false))
        {
            HashSet<string> columns = await ReadColumnsAsync(db, "asset_library_item", cancellationToken)
                .ConfigureAwait(false);
            if (!columns.Contains("url"))
            {
                failures.Add("legacy_asset_library_item_url_missing");
            }
            else
            {
                string hashProjection = columns.Contains("sha256") ? "sha256" : "NULL AS sha256";
                using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    $"SELECT url, {hashProjection} FROM asset_library_item;").ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    string? url = ReadNullableString(reader, "url");
                    if (!TryAddRequiredUrl(url, requiredUrls, out string? canonicalUrl))
                    {
                        failures.Add($"unrecognized_url:{url ?? string.Empty}");
                        continue;
                    }

                    AddLegacyHash(canonicalUrl!, ReadNullableString(reader, "sha256"), hashes, failures);
                }
            }
        }

        if (await TableExistsAsync(db, "article_asset_cleanup_queue", cancellationToken).ConfigureAwait(false))
        {
            HashSet<string> columns = await ReadColumnsAsync(db, "article_asset_cleanup_queue", cancellationToken)
                .ConfigureAwait(false);
            string[] required = ["normalized_url", "not_before_utc", "attempt_count", "updated_at_utc"];
            if (required.Any(column => !columns.Contains(column)))
            {
                failures.Add("legacy_cleanup_queue_shape_invalid");
            }
            else
            {
                string lastErrorProjection = columns.Contains("last_error") ? "last_error" : "NULL AS last_error";
                using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                    $"SELECT normalized_url, not_before_utc, attempt_count, {lastErrorProjection}, updated_at_utc FROM article_asset_cleanup_queue;")
                    .ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    if (!TryAddRequiredUrl(
                            ReadNullableString(reader, "normalized_url"),
                            requiredUrls,
                            out string? canonicalUrl))
                    {
                        failures.Add("unrecognized_url:legacy_cleanup");
                        continue;
                    }

                    AddCleanup(
                        canonicalUrl!,
                        new LegacyCleanup(
                            ReadDateTime(reader, "not_before_utc"),
                            ReadInt32(reader, "attempt_count"),
                            ReadNullableString(reader, "last_error"),
                            ReadDateTime(reader, "updated_at_utc")),
                        cleanupByUrl,
                        failures,
                        "legacy");
                }
            }
        }

        await ReadLegacyReferenceTableAsync(
            db,
            "article_asset_reference",
            "normalized_url",
            requiredUrls,
            ownership,
            failures,
            cancellationToken).ConfigureAwait(false);
        await ReadLegacyReferenceTableAsync(
            db,
            "asset_library_article_ref",
            "url",
            requiredUrls,
            ownership,
            failures,
            cancellationToken).ConfigureAwait(false);
    }

    private static async Task ReadLegacyReferenceTableAsync(
        ISqlSugarClient db,
        string table,
        string urlColumn,
        HashSet<string> requiredUrls,
        List<LegacyOwnershipClaim> ownership,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        if (!await TableExistsAsync(db, table, cancellationToken).ConfigureAwait(false))
        {
            return;
        }

        HashSet<string> columns = await ReadColumnsAsync(db, table, cancellationToken).ConfigureAwait(false);
        if (!columns.Contains(urlColumn))
        {
            failures.Add($"legacy_reference_url_missing:{table}");
            return;
        }

        var projection = new List<string> { $"{urlColumn} AS public_url" };
        bool hasKind = columns.Contains("source_kind");
        bool hasKey = columns.Contains("source_key");
        bool hasArticleId = columns.Contains("article_id");
        if (hasKind != hasKey || (!hasKind && !hasArticleId))
        {
            failures.Add($"legacy_reference_ownership_missing:{table}");
            return;
        }
        if (hasKind)
        {
            projection.Add("source_kind");
        }
        if (hasKey)
        {
            projection.Add("source_key");
        }
        if (hasArticleId)
        {
            projection.Add("article_id");
        }

        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            $"SELECT {string.Join(", ", projection)} FROM {table};").ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!TryAddRequiredUrl(
                    ReadNullableString(reader, "public_url"),
                    requiredUrls,
                    out string? canonicalUrl))
            {
                failures.Add($"unrecognized_url:{table}");
                continue;
            }

            if (hasKind && hasKey)
            {
                string kind = ReadString(reader, "source_kind");
                string key = ReadString(reader, "source_key");
                int? articleId = hasArticleId ? ReadNullableInt32(reader, "article_id") : null;
                if (string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(key))
                {
                    failures.Add($"legacy_reference_ownership_missing:{table}");
                }
                else
                {
                    if (!TryGetStorageKey(canonicalUrl!, out string storageKey))
                    {
                        failures.Add($"unrecognized_url:{table}");
                    }
                    else
                    {
                        ownership.Add(new LegacyOwnershipClaim(
                            table,
                            new SourceIdentity(kind, key),
                            storageKey,
                            articleId));
                    }
                }
            }
            else if (hasArticleId)
            {
                int? articleId = ReadNullableInt32(reader, "article_id");
                if (!articleId.HasValue)
                {
                    failures.Add($"legacy_reference_ownership_missing:{table}");
                }
                else if (TryGetStorageKey(canonicalUrl!, out string storageKey))
                {
                    ownership.Add(new LegacyOwnershipClaim(
                        table,
                        new SourceIdentity("article", articleId.Value.ToString(CultureInfo.InvariantCulture)),
                        storageKey,
                        articleId));
                }
            }
        }
    }

    private static void ValidateLegacyOwnership(
        IReadOnlyCollection<LegacyOwnershipClaim> claims,
        IReadOnlyDictionary<SourceIdentity, SourceSnapshot> sourceByIdentity,
        IReadOnlyDictionary<SourceIdentity, IReadOnlyDictionary<string, ReferenceAggregate>> referencesBySource,
        List<string> failures)
    {
        foreach (LegacyOwnershipClaim claim in claims)
        {
            if (!sourceByIdentity.TryGetValue(claim.Source, out SourceSnapshot? source))
            {
                failures.Add($"legacy_reference_source_unknown:{claim.Table}:{claim.Source.Kind}:{claim.Source.Key}");
                continue;
            }

            if (claim.ArticleId.HasValue && claim.ArticleId != source.ArticleId)
            {
                failures.Add($"legacy_reference_article_mismatch:{claim.Table}:{claim.Source.Kind}:{claim.Source.Key}");
                continue;
            }

            if (!referencesBySource.TryGetValue(claim.Source, out IReadOnlyDictionary<string, ReferenceAggregate>? references)
                || !references.ContainsKey(claim.StorageKey))
            {
                failures.Add($"legacy_reference_not_in_source:{claim.Table}:{claim.Source.Kind}:{claim.Source.Key}:{claim.StorageKey}");
            }
        }
    }

    private static void EnumeratePublicFiles(
        string root,
        HashSet<string> requiredUrls,
        List<string> failures,
        CancellationToken cancellationToken)
    {
        string illustrationRoot = Path.Combine(root, "illustration");
        if (!Directory.Exists(root))
        {
            failures.Add("storage_root_missing");
            return;
        }

        if (!Directory.Exists(illustrationRoot))
        {
            failures.Add("storage_illustration_root_missing");
            return;
        }

        if (!IsSafeDirectory(illustrationRoot))
        {
            failures.Add("unsafe_storage_root");
            return;
        }

        var pending = new Stack<string>();
        pending.Push(illustrationRoot);
        while (pending.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string directory = pending.Pop();
            IEnumerable<string> entries;
            try
            {
                entries = Directory.EnumerateFileSystemEntries(directory);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                failures.Add($"storage_enumeration_failed:{exception.GetType().Name}");
                continue;
            }

            foreach (string entry in entries)
            {
                cancellationToken.ThrowIfCancellationRequested();
                FileAttributes attributes;
                try
                {
                    attributes = File.GetAttributes(entry);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    failures.Add($"storage_entry_unreadable:{exception.GetType().Name}");
                    continue;
                }

                if ((attributes & FileAttributes.ReparsePoint) != 0)
                {
                    failures.Add("storage_reparse_point");
                    continue;
                }

                if ((attributes & FileAttributes.Directory) != 0)
                {
                    pending.Push(entry);
                    continue;
                }

                string relative = Path.GetRelativePath(root, entry)
                    .Replace(Path.DirectorySeparatorChar, '/')
                    .Replace(Path.AltDirectorySeparatorChar, '/');
                if (!TryParseStorageKey(relative, out string storageKey))
                {
                    failures.Add($"invalid_storage_file:{relative}");
                    continue;
                }

                requiredUrls.Add(PublicPrefix + storageKey);
            }
        }
    }

    private static async Task WriteCanonicalStateAsync(
        ISqlSugarClient db,
        IReadOnlyDictionary<string, MaterializedAsset> assetsByStorageKey,
        IReadOnlyDictionary<string, LegacyCleanup> cleanupByUrl,
        IReadOnlyDictionary<Guid, LegacyCleanup> preservedCleanup,
        IReadOnlyCollection<CanonicalReference> preservedReferences,
        IReadOnlyDictionary<SourceIdentity, SourceSnapshot> sourceByIdentity,
        IReadOnlyDictionary<SourceIdentity, IReadOnlyDictionary<string, ReferenceAggregate>> referencesBySource,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync("DELETE FROM content_asset_reference;").ConfigureAwait(false);
        await db.Ado.ExecuteCommandAsync("DELETE FROM content_asset_cleanup_queue;").ConfigureAwait(false);
        await db.Ado.ExecuteCommandAsync("DELETE FROM content_asset;").ConfigureAwait(false);

        const string InsertAsset =
            """
            INSERT INTO content_asset(
                id, storage_class, storage_key, media_type, extension, byte_length,
                sha256, width, height, owner_admin_principal_id, state,
                created_at_utc, updated_at_utc)
            VALUES (
                @Id, @StorageClass, @StorageKey, @MediaType, @Extension, @ByteLength,
                @Sha256, @Width, @Height, @OwnerAdminPrincipalId, @State,
                @CreatedAtUtc, @UpdatedAtUtc);
            """;
        IEnumerable<MaterializedAsset> allAssets = assetsByStorageKey.Values
            .OrderBy(static item => item.StorageKey, StringComparer.Ordinal);
        foreach (MaterializedAsset asset in allAssets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await db.Ado.ExecuteCommandAsync(
                InsertAsset,
                new SugarParameter("@Id", asset.AssetId),
                new SugarParameter("@StorageClass", asset.StorageClass),
                new SugarParameter("@StorageKey", asset.StorageKey),
                new SugarParameter("@MediaType", asset.MediaType),
                new SugarParameter("@Extension", asset.Extension),
                new SugarParameter("@ByteLength", asset.ByteLength),
                new SugarParameter("@Sha256", (object?)asset.Sha256 ?? DBNull.Value),
                new SugarParameter(
                    "@Width",
                    asset.Width.HasValue ? (object)asset.Width.Value : DBNull.Value,
                    System.Data.DbType.Int32),
                new SugarParameter(
                    "@Height",
                    asset.Height.HasValue ? (object)asset.Height.Value : DBNull.Value,
                    System.Data.DbType.Int32),
                new SugarParameter(
                    "@OwnerAdminPrincipalId",
                    asset.OwnerAdminPrincipalId.HasValue
                        ? (object)asset.OwnerAdminPrincipalId.Value
                        : DBNull.Value,
                    System.Data.DbType.Int64),
                new SugarParameter("@State", asset.State),
                new SugarParameter("@CreatedAtUtc", asset.CreatedAtUtc),
                new SugarParameter("@UpdatedAtUtc", asset.UpdatedAtUtc)).ConfigureAwait(false);
        }

        const string InsertCleanup =
            """
            INSERT INTO content_asset_cleanup_queue(
                asset_id, not_before_utc, attempt_count, last_error, updated_at_utc)
            VALUES (@AssetId, @NotBeforeUtc, @AttemptCount, @LastError, @UpdatedAtUtc);
            """;
        foreach ((Guid assetId, LegacyCleanup cleanup) in preservedCleanup.OrderBy(static pair => pair.Key))
        {
            await db.Ado.ExecuteCommandAsync(
                InsertCleanup,
                new SugarParameter("@AssetId", assetId),
                new SugarParameter("@NotBeforeUtc", AsUtc(cleanup.NotBeforeUtc)),
                new SugarParameter("@AttemptCount", cleanup.AttemptCount),
                new SugarParameter("@LastError", (object?)cleanup.LastError ?? DBNull.Value),
                new SugarParameter("@UpdatedAtUtc", AsUtc(cleanup.UpdatedAtUtc))).ConfigureAwait(false);
        }

        foreach ((string publicUrl, LegacyCleanup cleanup) in cleanupByUrl.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
        {
            TryGetStorageKey(publicUrl, out string storageKey);
            MaterializedAsset asset = assetsByStorageKey[storageKey];
            await db.Ado.ExecuteCommandAsync(
                InsertCleanup,
                new SugarParameter("@AssetId", asset.AssetId),
                new SugarParameter("@NotBeforeUtc", AsUtc(cleanup.NotBeforeUtc)),
                new SugarParameter("@AttemptCount", cleanup.AttemptCount),
                new SugarParameter("@LastError", (object?)cleanup.LastError ?? DBNull.Value),
                new SugarParameter("@UpdatedAtUtc", AsUtc(cleanup.UpdatedAtUtc))).ConfigureAwait(false);
        }

        const string InsertReference =
            """
            INSERT INTO content_asset_reference(
                asset_id, source_kind, source_key, article_id, reference_count,
                alt_text, updated_at_utc)
            VALUES (
                @AssetId, @SourceKind, @SourceKey, @ArticleId, @ReferenceCount,
                @AltText, @UpdatedAtUtc);
            """;
        foreach (CanonicalReference reference in preservedReferences
            .OrderBy(static item => item.AssetId)
            .ThenBy(static item => item.SourceKind, StringComparer.Ordinal)
            .ThenBy(static item => item.SourceKey, StringComparer.Ordinal))
        {
            await db.Ado.ExecuteCommandAsync(
                InsertReference,
                new SugarParameter("@AssetId", reference.AssetId),
                new SugarParameter("@SourceKind", reference.SourceKind),
                new SugarParameter("@SourceKey", reference.SourceKey),
                new SugarParameter(
                    "@ArticleId",
                    reference.ArticleId.HasValue ? (object)reference.ArticleId.Value : DBNull.Value,
                    System.Data.DbType.Int32),
                new SugarParameter("@ReferenceCount", reference.ReferenceCount),
                new SugarParameter("@AltText", (object?)reference.AltText ?? DBNull.Value),
                new SugarParameter("@UpdatedAtUtc", AsUtc(reference.UpdatedAtUtc))).ConfigureAwait(false);
        }

        foreach ((SourceIdentity source, IReadOnlyDictionary<string, ReferenceAggregate> references) in referencesBySource
            .OrderBy(static pair => pair.Key.Kind, StringComparer.Ordinal)
            .ThenBy(static pair => pair.Key.Key, StringComparer.Ordinal))
        {
            foreach ((string storageKey, ReferenceAggregate reference) in references.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
            {
                MaterializedAsset asset = assetsByStorageKey[storageKey];
                int? sourceArticleId = sourceByIdentity[source].ArticleId;
                await db.Ado.ExecuteCommandAsync(
                    InsertReference,
                    new SugarParameter("@AssetId", asset.AssetId),
                    new SugarParameter("@SourceKind", source.Kind),
                    new SugarParameter("@SourceKey", source.Key),
                    new SugarParameter(
                        "@ArticleId",
                        sourceArticleId.HasValue
                            ? (object)sourceArticleId.Value
                            : DBNull.Value,
                        System.Data.DbType.Int32),
                    new SugarParameter("@ReferenceCount", reference.Count),
                    new SugarParameter("@AltText", (object?)reference.AltText ?? DBNull.Value),
                    new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
            }
        }

        await db.Ado.ExecuteCommandAsync(
            """
            DELETE FROM content_asset_cleanup_queue queue
            WHERE EXISTS (
                SELECT 1 FROM content_asset_reference reference
                WHERE reference.asset_id = queue.asset_id);

            UPDATE content_asset asset
            SET state = 'active', updated_at_utc = @UpdatedAtUtc
            WHERE EXISTS (
                SELECT 1 FROM content_asset_reference reference
                WHERE reference.asset_id = asset.id);
            """,
            new SugarParameter("@UpdatedAtUtc", now)).ConfigureAwait(false);
    }

    private static void AddSource(
        SourceSnapshot source,
        List<SourceSnapshot> sources,
        Dictionary<SourceIdentity, SourceSnapshot> sourceByIdentity,
        HashSet<string> requiredUrls,
        List<string> failures)
    {
        if (source.Identity.Key.Length > 160)
        {
            failures.Add($"source_key_too_long:{source.Identity.Kind}:{source.Identity.Key.Length}");
            return;
        }

        if (!sourceByIdentity.TryAdd(source.Identity, source))
        {
            failures.Add($"duplicate_source:{source.Identity.Kind}:{source.Identity.Key}");
            return;
        }

        sources.Add(source);
        foreach (string url in EnumerateUrls(source.Markdown, source.CoverUrl))
        {
            if (!TryAddRequiredUrl(url, requiredUrls, out _))
            {
                failures.Add($"unrecognized_url:{url}");
            }
        }
    }

    private static bool TryBuildReferences(
        string markdown,
        string? coverUrl,
        out Dictionary<string, ReferenceAggregate> references,
        out string? failure)
    {
        var builtReferences = new Dictionary<string, ReferenceAggregate>(StringComparer.Ordinal);
        references = builtReferences;
        failure = null;
        foreach (IllustrationReference illustration in ExtractIllustrationReferences(markdown ?? string.Empty))
        {
            if (!TryGetIllustrationStorageKey(illustration.Url, out string storageKey))
            {
                failure = illustration.Url;
                return false;
            }

            int count = CountOccurrences(markdown, illustration.Url);
            AddReference(storageKey, illustration.AltText, count);
        }

        if (!string.IsNullOrWhiteSpace(coverUrl))
        {
            if (!TryGetIllustrationStorageKey(coverUrl, out string storageKey))
            {
                failure = coverUrl;
                return false;
            }

            AddReference(storageKey, null, 1);
        }

        return true;

        void AddReference(string storageKey, string? altText, int count)
        {
            if (count <= 0)
            {
                return;
            }

            builtReferences.TryGetValue(storageKey, out ReferenceAggregate? existing);
            builtReferences[storageKey] = existing is null
                ? new ReferenceAggregate(count, NormalizeAltText(altText))
                : existing with
                {
                    Count = checked(existing.Count + count),
                    AltText = existing.AltText ?? NormalizeAltText(altText)
                };
        }
    }

    private static IEnumerable<string> EnumerateUrls(string markdown, string? coverUrl)
    {
        foreach (IllustrationReference reference in ExtractIllustrationReferences(markdown ?? string.Empty))
        {
            yield return reference.Url;
        }

        if (!string.IsNullOrWhiteSpace(coverUrl))
        {
            yield return coverUrl;
        }
    }

    private static List<IllustrationReference> ExtractIllustrationReferences(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return [];
        }

        var references = new Dictionary<string, IllustrationReference>(StringComparer.Ordinal);
        ReadOnlySpan<char> span = content.AsSpan();
        foreach (ValueMatch match in MarkdownIllustrationRegex().EnumerateMatches(span))
        {
            ReadOnlySpan<char> markdown = span.Slice(match.Index, match.Length);
            int altEnd = markdown.IndexOf("](".AsSpan());
            if (altEnd < 2)
            {
                continue;
            }

            ValueMatch urlMatch = default;
            bool found = false;
            foreach (ValueMatch candidate in IllustrationRegex().EnumerateMatches(markdown))
            {
                urlMatch = candidate;
                found = true;
                break;
            }

            if (!found)
            {
                continue;
            }

            string url = markdown.Slice(urlMatch.Index, urlMatch.Length).Trim().ToString();
            if (url.Length == 0 || references.ContainsKey(url))
            {
                continue;
            }

            string alt = markdown.Slice(2, altEnd - 2).Trim().ToString();
            references[url] = new IllustrationReference(url, alt.Length == 0 ? null : alt);
        }

        foreach (ValueMatch match in IllustrationRegex().EnumerateMatches(span))
        {
            string url = span.Slice(match.Index, match.Length).Trim().ToString();
            if (url.Length > 0 && !references.ContainsKey(url) && !IsInsideUnclosedMarkdownImage(span, match.Index))
            {
                references[url] = new IllustrationReference(url, null);
            }
        }

        return [.. references.Values];
    }

    private static bool IsInsideUnclosedMarkdownImage(ReadOnlySpan<char> source, int urlIndex)
    {
        ReadOnlySpan<char> beforeUrl = source[..urlIndex];
        int opener = beforeUrl.LastIndexOf("](".AsSpan());
        if (opener < 0)
        {
            return false;
        }

        int imageStart = beforeUrl[..opener].LastIndexOf("![".AsSpan());
        return imageStart >= 0 && beforeUrl[(opener + 2)..].Trim().IsEmpty;
    }

    private static bool TryAddRequiredUrl(string? value, HashSet<string> requiredUrls, out string? canonicalUrl)
    {
        canonicalUrl = null;
        if (!TryGetIllustrationStorageKey(value, out string storageKey))
        {
            return false;
        }

        canonicalUrl = PublicPrefix + storageKey;
        requiredUrls.Add(canonicalUrl);
        return true;
    }

    private static bool TryGetStorageKey(string? publicUrl, out string storageKey)
    {
        storageKey = string.Empty;
        if (string.IsNullOrWhiteSpace(publicUrl))
        {
            return false;
        }

        string candidate = publicUrl.Trim();
        if (candidate.IndexOfAny(['?', '#', '\0', '\\']) >= 0
            || candidate.IndexOf('%') >= 0
            || !candidate.StartsWith(PublicPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        return TryParseStorageKey(candidate[PublicPrefix.Length..], out storageKey);
    }

    private static bool TryGetIllustrationStorageKey(string? publicUrl, out string storageKey)
        => TryGetStorageKey(publicUrl, out storageKey) && IsCutoverStorageKey(storageKey);

    private static bool TryParseStorageKey(string? value, out string storageKey)
    {
        storageKey = string.Empty;
        if (string.IsNullOrWhiteSpace(value)
            || value.Length > 512
            || value.IndexOfAny(['\0', '\\', '%']) >= 0
            || Path.IsPathRooted(value)
            || (value.Length >= 2 && char.IsAsciiLetter(value[0]) && value[1] == ':'))
        {
            return false;
        }

        string[] segments = value.Split('/');
        if (segments.Length == 0)
        {
            return false;
        }

        foreach (string segment in segments)
        {
            if (segment.Length == 0 || segment.Length > 255 || segment is "." or "..")
            {
                return false;
            }

            foreach (char character in segment)
            {
                if (!char.IsAsciiLetterOrDigit(character)
                    && character is not '.' and not '_' and not '-')
                {
                    return false;
                }
            }
        }

        storageKey = string.Join('/', segments);
        return true;
    }

    private static string ResolvePath(string root, string storageKey)
    {
        string normalizedRoot = Path.GetFullPath(root);
        string path = Path.GetFullPath(Path.Combine(
            normalizedRoot,
            storageKey.Replace('/', Path.DirectorySeparatorChar)));
        string relative = Path.GetRelativePath(normalizedRoot, path);
        if (relative is "." or ".."
            || Path.IsPathRooted(relative)
            || relative.StartsWith($"..{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
            || relative.StartsWith($"..{Path.AltDirectorySeparatorChar}", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("content_asset_cutover_storage_escape");
        }

        return path;
    }

    private static string NormalizeRoot(string root)
    {
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new InvalidOperationException("content_asset_cutover_storage_root_invalid");
        }

        try
        {
            return Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or PathTooLongException)
        {
            throw new InvalidOperationException("content_asset_cutover_storage_root_invalid", exception);
        }
    }

    private static bool IsSafeDirectory(string path)
    {
        try
        {
            return (File.GetAttributes(path) & FileAttributes.ReparsePoint) == 0;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static bool IsRegularFile(string path)
    {
        try
        {
            FileAttributes attributes = File.GetAttributes(path);
            return (attributes & FileAttributes.ReparsePoint) == 0
                && (attributes & FileAttributes.Directory) == 0;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private static void ValidatePrototypeMetadata(
        PrototypeAsset? prototype,
        MigrationMediaMetadata media,
        string extension,
        long byteLength,
        string publicUrl,
        List<string> failures)
    {
        if (prototype is null)
        {
            return;
        }

        if (prototype.ByteLength != byteLength)
        {
            failures.Add($"metadata_conflict:{publicUrl}:byte_length:{prototype.ByteLength}:{byteLength}");
        }
        if (!string.IsNullOrWhiteSpace(prototype.MediaType)
            && !string.Equals(prototype.MediaType, media.MediaType, StringComparison.OrdinalIgnoreCase))
        {
            failures.Add($"metadata_conflict:{publicUrl}:media_type");
        }
        if (!string.IsNullOrWhiteSpace(prototype.Extension)
            && !string.Equals(prototype.Extension, extension, StringComparison.OrdinalIgnoreCase))
        {
            failures.Add($"metadata_conflict:{publicUrl}:extension");
        }
        if (prototype.Width.HasValue && prototype.Width != media.Width)
        {
            failures.Add($"metadata_conflict:{publicUrl}:width");
        }
        if (prototype.Height.HasValue && prototype.Height != media.Height)
        {
            failures.Add($"metadata_conflict:{publicUrl}:height");
        }
    }

    private static void AddLegacyHash(
        string publicUrl,
        string? hash,
        Dictionary<string, HashSet<string>> hashes,
        List<string> failures)
    {
        if (string.IsNullOrWhiteSpace(hash))
        {
            return;
        }

        string normalized = hash.Trim().ToLowerInvariant();
        if (normalized.StartsWith("sha256:", StringComparison.Ordinal))
        {
            normalized = normalized["sha256:".Length..];
        }
        if (normalized.Length != 64 || normalized.Any(static character => !char.IsAsciiHexDigit(character)))
        {
            failures.Add($"invalid_legacy_hash:{publicUrl}");
            return;
        }

        if (!hashes.TryGetValue(publicUrl, out HashSet<string>? values))
        {
            values = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            hashes.Add(publicUrl, values);
        }
        values.Add(normalized);
    }

    private static void AddCleanup(
        string publicUrl,
        LegacyCleanup value,
        Dictionary<string, LegacyCleanup> cleanupByUrl,
        List<string> failures,
        string source)
    {
        if (cleanupByUrl.TryGetValue(publicUrl, out LegacyCleanup? existing))
        {
            if (existing != value)
            {
                failures.Add($"cleanup_conflict:{publicUrl}:{source}");
            }
            return;
        }

        cleanupByUrl.Add(publicUrl, value);
    }

    private static Guid CreateDeterministicAssetId(string storageKey, string sha256)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes($"fsusblog:content-asset:{storageKey}\0{sha256}"));
        digest[6] = (byte)((digest[6] & 0x0f) | 0x50);
        digest[8] = (byte)((digest[8] & 0x3f) | 0x80);
        return new Guid(digest.AsSpan(0, 16));
    }

    private static bool TryParseFileNameAssetId(string value, out Guid assetId)
        => Guid.TryParseExact(value, "N", out assetId);

    private static bool IsCutoverStorageKey(string storageKey)
        => storageKey.StartsWith("illustration/", StringComparison.Ordinal);

    private static bool IsValidStorageClass(string storageClass)
        => string.Equals(storageClass, PublicStorageClass, StringComparison.Ordinal)
            || string.Equals(storageClass, "private", StringComparison.Ordinal);

    private static bool IsValidState(string state)
        => string.Equals(state, ActiveState, StringComparison.Ordinal)
            || string.Equals(state, PendingDeleteState, StringComparison.Ordinal);

    private static bool IsValidSourceKind(string sourceKind)
        => sourceKind is "article" or "draft" or "revision";

    private static MaterializedAsset ToMaterializedAsset(PrototypeAsset prototype)
        => new(
            prototype.AssetId,
            prototype.StorageClass,
            prototype.StorageKey,
            prototype.MediaType,
            prototype.Extension,
            prototype.ByteLength,
            prototype.Sha256,
            prototype.Width,
            prototype.Height,
            prototype.OwnerAdminPrincipalId,
            prototype.State,
            AsUtc(prototype.CreatedAtUtc),
            AsUtc(prototype.UpdatedAtUtc));

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
            count = checked(count + 1);
            offset = index + value.Length;
        }

        return count;
    }

    private static DateTime AsUtc(DateTime value)
        => value.Kind == DateTimeKind.Utc ? value : DateTime.SpecifyKind(value, DateTimeKind.Utc);

    private static async Task<bool> TableExistsAsync(
        ISqlSugarClient db,
        string table,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        object result = await db.Ado.GetScalarAsync(
            "SELECT to_regclass(@TableName) IS NOT NULL;",
            new SugarParameter("@TableName", "public." + table)).ConfigureAwait(false);
        return Convert.ToBoolean(result, CultureInfo.InvariantCulture);
    }

    private static async Task<HashSet<string>> ReadColumnsAsync(
        ISqlSugarClient db,
        string table,
        CancellationToken cancellationToken)
    {
        var columns = new HashSet<string>(StringComparer.Ordinal);
        using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = @TableName;
            """,
            new SugarParameter("@TableName", table)).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            columns.Add(ReadString(reader, "column_name"));
        }

        return columns;
    }

    private static object? ReadValue(DbDataReader reader, string column)
        => reader.IsDBNull(reader.GetOrdinal(column)) ? null : reader.GetValue(reader.GetOrdinal(column));

    private static string ReadString(DbDataReader reader, string column)
        => Convert.ToString(ReadValue(reader, column), CultureInfo.InvariantCulture) ?? string.Empty;

    private static string? ReadNullableString(DbDataReader reader, string column)
        => Convert.ToString(ReadValue(reader, column), CultureInfo.InvariantCulture);

    private static int ReadInt32(DbDataReader reader, string column)
        => Convert.ToInt32(ReadValue(reader, column), CultureInfo.InvariantCulture);

    private static long ReadInt64(DbDataReader reader, string column)
        => Convert.ToInt64(ReadValue(reader, column), CultureInfo.InvariantCulture);

    private static int? ReadNullableInt32(DbDataReader reader, string column)
        => ReadValue(reader, column) is object value
            ? Convert.ToInt32(value, CultureInfo.InvariantCulture)
            : null;

    private static long? ReadNullableInt64(DbDataReader reader, string column)
        => ReadValue(reader, column) is object value
            ? Convert.ToInt64(value, CultureInfo.InvariantCulture)
            : null;

    private static DateTime ReadDateTime(DbDataReader reader, string column)
        => AsUtc(Convert.ToDateTime(ReadValue(reader, column), CultureInfo.InvariantCulture));

    private static bool TryReadGuid(DbDataReader reader, string column, out Guid value)
    {
        object? raw = ReadValue(reader, column);
        if (raw is Guid guid)
        {
            value = guid;
            return true;
        }

        return Guid.TryParse(Convert.ToString(raw, CultureInfo.InvariantCulture), out value);
    }

    private sealed record SourceIdentity(string Kind, string Key);

    private sealed record SourceSnapshot(
        SourceIdentity Identity,
        int? ArticleId,
        string Markdown,
        string? CoverUrl);

    private sealed record LegacyOwnershipClaim(
        string Table,
        SourceIdentity Source,
        string StorageKey,
        int? ArticleId);

    private sealed record LegacyCleanup(
        DateTime NotBeforeUtc,
        int AttemptCount,
        string? LastError,
        DateTime UpdatedAtUtc);

    private sealed record CanonicalReference(
        Guid AssetId,
        string SourceKind,
        string SourceKey,
        int? ArticleId,
        int ReferenceCount,
        string? AltText,
        DateTime UpdatedAtUtc);

    private readonly record struct CanonicalReferenceIdentity(
        Guid AssetId,
        string SourceKind,
        string SourceKey);

    private sealed record ReferenceAggregate(int Count, string? AltText);

    private sealed record PrototypeAsset(
        Guid AssetId,
        string StorageClass,
        string StorageKey,
        string MediaType,
        string Extension,
        long ByteLength,
        string? Sha256,
        int? Width,
        int? Height,
        long? OwnerAdminPrincipalId,
        string State,
        DateTime CreatedAtUtc,
        DateTime UpdatedAtUtc);

    private sealed record MaterializedAsset(
        Guid AssetId,
        string StorageClass,
        string StorageKey,
        string MediaType,
        string Extension,
        long ByteLength,
        string? Sha256,
        int? Width,
        int? Height,
        long? OwnerAdminPrincipalId,
        string State,
        DateTime CreatedAtUtc,
        DateTime UpdatedAtUtc);

    private readonly record struct IllustrationReference(string Url, string? AltText);

    [GeneratedRegex(@"/uploads/illustration/[\w\-\.\(\)\s\[\]]+?\.(?i:jpg|jpeg|png|gif|webp|avif|svg)", RegexOptions.IgnoreCase)]
    private static partial Regex IllustrationRegex();

    [GeneratedRegex(@"!\[(?<alt>[^\]]*)\]\((?<url>/uploads/illustration/[\w\-\.\(\)\s\[\]]+?\.(?i:jpg|jpeg|png|gif|webp|avif|svg))(?:\s+""[^""]*"")?\)", RegexOptions.IgnoreCase)]
    private static partial Regex MarkdownIllustrationRegex();
}

internal readonly record struct MigrationMediaMetadata(
    string MediaType,
    int Width,
    int Height);

internal static partial class MigrationMediaInspector
{
    internal static bool TryInspect(
        string extension,
        ReadOnlySpan<byte> bytes,
        out MigrationMediaMetadata metadata)
    {
        extension = extension.StartsWith(".", StringComparison.Ordinal)
            ? extension.ToLowerInvariant()
            : "." + extension.ToLowerInvariant();
        string mediaType = extension switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".png" => "image/png",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".ico" => "image/x-icon",
            ".svg" => "image/svg+xml",
            _ => string.Empty
        };

        int width = 0;
        int height = 0;
        bool recognized = extension switch
        {
            ".png" => TryReadPng(bytes, out width, out height),
            ".gif" => TryReadGif(bytes, out width, out height),
            ".jpg" or ".jpeg" => TryReadJpeg(bytes, out width, out height),
            ".webp" => TryReadWebp(bytes, out width, out height),
            ".ico" => TryReadIco(bytes, out width, out height),
            ".svg" => TryReadSvg(bytes, out width, out height),
            _ => false
        };
        metadata = recognized
            ? new MigrationMediaMetadata(mediaType, width, height)
            : default;

        return recognized;
    }

    private static bool TryReadPng(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 24 || !bytes[..8].SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }))
        {
            return false;
        }
        width = BinaryPrimitives.ReadInt32BigEndian(bytes[16..20]);
        height = BinaryPrimitives.ReadInt32BigEndian(bytes[20..24]);
        return width > 0 && height > 0;
    }

    private static bool TryReadGif(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 10 || (!bytes[..6].SequenceEqual("GIF87a"u8) && !bytes[..6].SequenceEqual("GIF89a"u8)))
        {
            return false;
        }
        width = BinaryPrimitives.ReadUInt16LittleEndian(bytes[6..8]);
        height = BinaryPrimitives.ReadUInt16LittleEndian(bytes[8..10]);
        return width > 0 && height > 0;
    }

    private static bool TryReadJpeg(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 4 || bytes[0] != 0xff || bytes[1] != 0xd8)
        {
            return false;
        }
        int offset = 2;
        while (offset + 4 <= bytes.Length)
        {
            while (offset < bytes.Length && bytes[offset] != 0xff)
            {
                offset++;
            }
            while (offset < bytes.Length && bytes[offset] == 0xff)
            {
                offset++;
            }
            if (offset >= bytes.Length)
            {
                return false;
            }
            byte marker = bytes[offset++];
            if (marker is 0xd8 or 0xd9 || marker is >= 0xd0 and <= 0xd7)
            {
                continue;
            }
            if (offset + 2 > bytes.Length)
            {
                return false;
            }
            int length = BinaryPrimitives.ReadUInt16BigEndian(bytes[offset..(offset + 2)]);
            if (length < 2 || offset + length > bytes.Length)
            {
                return false;
            }
            if (IsStartOfFrame(marker) && length >= 7)
            {
                height = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 3)..(offset + 5)]);
                width = BinaryPrimitives.ReadUInt16BigEndian(bytes[(offset + 5)..(offset + 7)]);
                return width > 0 && height > 0;
            }
            offset += length;
        }
        return false;
    }

    private static bool IsStartOfFrame(byte marker)
        => marker is 0xc0 or 0xc1 or 0xc2 or 0xc3 or 0xc5 or 0xc6 or 0xc7
            or 0xc9 or 0xca or 0xcb or 0xcd or 0xce or 0xcf;

    private static bool TryReadWebp(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 30 || !bytes[..4].SequenceEqual("RIFF"u8) || !bytes[8..12].SequenceEqual("WEBP"u8))
        {
            return false;
        }
        if (bytes[12..16].SequenceEqual("VP8X"u8))
        {
            width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
            height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
            return true;
        }
        if (bytes[12..16].SequenceEqual("VP8L"u8) && bytes.Length >= 25 && bytes[20] == 0x2f)
        {
            int bits = BinaryPrimitives.ReadInt32LittleEndian(bytes[21..25]);
            width = (bits & 0x3fff) + 1;
            height = ((bits >> 14) & 0x3fff) + 1;
            return true;
        }
        if (bytes[12..16].SequenceEqual("VP8 "u8))
        {
            width = BinaryPrimitives.ReadUInt16LittleEndian(bytes[26..28]) & 0x3fff;
            height = BinaryPrimitives.ReadUInt16LittleEndian(bytes[28..30]) & 0x3fff;
            return width > 0 && height > 0;
        }
        return false;
    }

    private static bool TryReadIco(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        if (bytes.Length < 22
            || BinaryPrimitives.ReadUInt16LittleEndian(bytes[..2]) != 0
            || BinaryPrimitives.ReadUInt16LittleEndian(bytes[2..4]) != 1
            || BinaryPrimitives.ReadUInt16LittleEndian(bytes[4..6]) == 0)
        {
            return false;
        }
        width = bytes[6] == 0 ? 256 : bytes[6];
        height = bytes[7] == 0 ? 256 : bytes[7];
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(bytes[14..18]);
        uint payloadOffset = BinaryPrimitives.ReadUInt32LittleEndian(bytes[18..22]);
        return payloadLength > 0
            && payloadOffset >= 22
            && payloadOffset <= (uint)bytes.Length
            && payloadLength <= (uint)bytes.Length - payloadOffset;
    }

    private static bool TryReadSvg(ReadOnlySpan<byte> bytes, out int width, out int height)
    {
        width = height = 0;
        string text = Encoding.UTF8.GetString(bytes);
        Match match = SvgDimensionsRegex().Match(text);
        if (!match.Success)
        {
            match = SvgViewBoxRegex().Match(text);
        }
        if (!match.Success)
        {
            return false;
        }
        width = (int)Math.Ceiling(double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture));
        height = (int)Math.Ceiling(double.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture));
        return width > 0 && height > 0;
    }

    [GeneratedRegex("<svg[^>]*width=['\"]([0-9]+(?:\\.[0-9]+)?)[^'\"]*['\"][^>]*height=['\"]([0-9]+(?:\\.[0-9]+)?)[^'\"]*['\"]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SvgDimensionsRegex();

    [GeneratedRegex("<svg[^>]*viewBox=['\"][^'\"]*\\s([0-9]+(?:\\.[0-9]+)?)\\s([0-9]+(?:\\.[0-9]+)?)[^'\"]*['\"]", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SvgViewBoxRegex();
}
