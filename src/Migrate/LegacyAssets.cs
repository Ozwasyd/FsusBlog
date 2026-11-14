using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

internal static partial class Migration
{
    private const int LegacyAssetLimit = 5000;
    private const long LegacyAssetByteLimit = 1024L * 1024 * 1024;
    private static readonly string[] AssetColumns =
    [
        "id", "storage_class", "storage_key", "media_type", "extension", "byte_length", "sha256", "width", "height",
        "owner_admin_principal_id", "state", "created_at_utc", "updated_at_utc"
    ];
    private static readonly string[] AssetReferenceColumns =
    [
        "asset_id", "source_kind", "source_key", "article_id", "reference_count", "alt_text", "updated_at_utc"
    ];

    private sealed record AssetCustody(Guid AssetId, string StorageClass, long Bytes, string? ExpectedSha256, string? ObservedSha256,
        string Status);
    private sealed record AssetMeta(Guid Id, string StorageClass, string Key, string Extension, string MediaType, long Bytes,
        string? Digest, long? Width, long? Height, long? Owner, string State, object Created, object Updated);
    private sealed record AssetSnapshot(LegacySource Source, DbTransaction Transaction, LegacyTable Principals,
        AssetMeta[] Metadata, string MetadataSha256, List<AssetCustody> Custody, AssetReferenceAudit References,
        Dictionary<string, long> Issues, SafeFileHandle PublicRoot, SafeFileHandle PrivateRoot);

    private static async Task<int> VerifyLegacyAssetsAsync(string provider, string publicPath, string privatePath,
        CancellationToken token)
        => await ObserveLegacyAssetSnapshotAsync(provider, publicPath, privatePath, (snapshot, _) =>
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                sourceReference = LegacyReference,
                provider,
                assetMetadataSha256 = snapshot.MetadataSha256,
                custody = snapshot.Custody,
                references = new { snapshot.References.Total, snapshot.References.Articles, snapshot.References.Revisions,
                    snapshot.References.Drafts, snapshot.References.Sha256 },
                issues = snapshot.Issues.OrderBy(entry => entry.Key).Select(entry => new { kind = entry.Key, count = entry.Value }),
                readyToApply = false,
                remaining = new[] { "asset content transformation and rights publication", "draft source references and their ownership",
                    "authorization and live installation or reference rewrite are unavailable" }
            }, Json));
            return Task.FromResult(snapshot.Issues.Count == 0 ? 0 : 2);
        }, token);

    private static async Task<int> ObserveLegacyAssetSnapshotAsync(string provider, string publicPath, string privatePath,
        Func<AssetSnapshot, CancellationToken, Task<int>> observe, CancellationToken token,
        Func<LegacySource, DbTransaction, CancellationToken, Task>? admitSource = null)
    {
        using var cancellation = CancellationTokenSource.CreateLinkedTokenSource(token);
        cancellation.CancelAfter(TimeSpan.FromMinutes(4));
        var ct = cancellation.Token;
        if ((!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) ||
            !Path.IsPathFullyQualified(publicPath) || !Path.IsPathFullyQualified(privatePath))
            throw new ArgumentException("Legacy assets require two canonical offline Unix storage roots.");
        ValidateLegacyAssetRoots(publicPath, privatePath);
        using var publicRoot = OpenImportBackupDirectory(publicPath);
        using var privateRoot = OpenImportBackupDirectory(privatePath);

        try
        {
            var source = ParseLegacySource(provider);
            await using var database = source.Connection;
            await database.OpenAsync(ct);
            await using var transaction = await BeginLegacyReadAsync(database, ct);
            if (admitSource is not null) await admitSource(source, transaction, ct);
            var catalog = await ReadLegacyCatalogAsync(source, transaction, ct);
            if (catalog.Any(table => table.Name.Equals("v2_schema", StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("The attachment verifier requires a v1 source.");
            var assetTable = RequireAssetTable("content_asset", AssetColumns);
            var referenceTable = RequireAssetTable("content_asset_reference", AssetReferenceColumns);
            var articleTable = RequireAssetTable("article", ["id"]);
            var revisionTable = RequireAssetTable("article_revision", ["id", "article_id"]);
            var admins = RequireAssetTable("admin_principal", ["id"]);
            var assets = await ReadAssetMetadataAsync(source, transaction, assetTable, ct);
            var known = assets.ToDictionary(meta => meta.Id);
            var issues = new Dictionary<string, long>(StringComparer.Ordinal);
            var custody = new List<AssetCustody>();
            var principals = new Dictionary<long, bool>();
            var buffer = new byte[128 * 1024];
            using var metadata = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            foreach (var column in AssetColumns) AppendLegacyValue(metadata, column);
            long totalBytes = 0;
            foreach (var asset in assets)
            {
                ct.ThrowIfCancellationRequested();
                AppendAssetMetadata(metadata, asset);
                var assetStatus = CheckAssetMetadata(asset);
                if (assetStatus is null && asset.StorageClass == "private" && asset.Owner is not > 0)
                    assetStatus = "private-owner-missing";
                if (assetStatus is null && asset.Owner is { } owner)
                {
                    if (!principals.TryGetValue(owner, out var exists))
                    {
                        exists = owner > 0 && await FindLegacyAssetIdAsync(source, transaction, admins, "id", owner, ct) == owner;
                        principals.Add(owner, exists);
                    }
                    if (!exists) assetStatus = "asset-owner-unresolved";
                }
                if (assetStatus is not null)
                {
                    Add(assetStatus);
                    custody.Add(new AssetCustody(asset.Id, asset.StorageClass is "public" or "private" ? asset.StorageClass : "unknown",
                        asset.Bytes, IsLegacyAssetDigest(asset.Digest) ? asset.Digest : null, null, assetStatus));
                    continue;
                }
                totalBytes = checked(totalBytes + asset.Bytes);
                if (totalBytes > LegacyAssetByteLimit)
                    throw new InvalidOperationException("Legacy assets exceed the verification run byte budget.");
                var isPrivate = asset.StorageClass == "private";
                var (observed, failure) = await HashLegacyAssetFileAsync(isPrivate ? privateRoot : publicRoot,
                    isPrivate ? privatePath : publicPath, asset.Key, asset.Bytes, buffer, ct);
                var status = failure ?? (asset.Digest is null ? "legacy-digest-unavailable" :
                    string.Equals(asset.Digest, observed, StringComparison.OrdinalIgnoreCase) ? "verified" : "digest-mismatch");
                if (status != "verified") Add(status);
                custody.Add(new AssetCustody(asset.Id, asset.StorageClass, asset.Bytes, asset.Digest, observed, status));
            }

            var refs = await VerifyAssetReferencesAsync(source, transaction, referenceTable, articleTable, revisionTable,
                known, Add, ct);
            foreach (var (tableName, issue) in new[]
            {
                ("content_asset_cleanup_queue", "cleanup-pending"),
                ("article_template_version_asset", "template-asset-references-unsupported"),
                ("article_asset_cleanup_queue", "pre-cutover-article-asset-cleanup"),
                ("article_asset_reference", "pre-cutover-article-asset-references"),
                ("asset_library_article_ref", "pre-cutover-library-article-references"),
                ("asset_library_item", "pre-cutover-library-assets")
            })
            {
                var matches = catalog.Where(table => table.Name.Equals(tableName, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (matches.Length == 0) continue;
                if (matches is not [var table] || !source.IsSnapshotTable(table.Kind))
                    throw new InvalidOperationException($"The legacy attachment dependency cannot be measured: {tableName}.");
                var rows = await CountAsync($"FROM {source.Table(table)}", transaction, ct);
                if (rows > 0) issues[issue] = rows;
            }
            var snapshot = new AssetSnapshot(source, transaction, admins, assets, Convert.ToHexStringLower(metadata.GetHashAndReset()),
                custody, refs, issues, publicRoot, privateRoot);
            var result = await observe(snapshot, ct);
            await transaction.RollbackAsync(ct);
            return result;

            LegacyTable RequireAssetTable(string name, string[] columns) =>
                catalog.Where(table => table.Name.Equals(name, StringComparison.OrdinalIgnoreCase)).ToArray() is [var table] &&
                source.IsSnapshotTable(table.Kind) &&
                columns.All(column => HasField(table, column))
                    ? table : throw new InvalidOperationException($"Required v1 asset authority differs: {name}.");

            void Add(string name) => issues[name] = issues.GetValueOrDefault(name) + 1;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested && cancellation.IsCancellationRequested)
        {
            throw new InvalidOperationException("The attachment verification exceeded its run budget.");
        }
        catch (DbException error)
        {
            throw new InvalidOperationException($"The source asset catalog could not be read ({error.GetType().Name}).");
        }
        catch (Exception error) when (error is InvalidCastException or OverflowException)
        {
            throw new InvalidOperationException("The source catalog contains an unsupported asset field representation.");
        }
    }

    private static async Task<AssetMeta[]> ReadAssetMetadataAsync(LegacySource source, DbTransaction transaction,
        LegacyTable table, CancellationToken token)
    {
        await RequireBoundedAssetTextAsync(source, transaction, table,
            [("id", 36), ("storage_class", 16), ("storage_key", 512), ("extension", 64), ("media_type", 508),
            ("sha256", 64), ("state", 16), ("created_at_utc", 64), ("updated_at_utc", 64)], token);
        var fields = AssetColumns.Select(col => source.Field(table, col));
        await using var command = CreateLegacyCommand(transaction,
            $"SELECT {string.Join(", ", fields)} FROM {source.Table(table)} ORDER BY {source.Field(table, "id")} LIMIT {LegacyAssetLimit + 1}");
        await using var rows = await command.ExecuteReaderAsync(token);
        var items = new List<AssetMeta>();
        var ids = new HashSet<Guid>();
        var locators = new HashSet<string>(StringComparer.Ordinal);
        while (await rows.ReadAsync(token))
        {
            var id = AssetGuid(rows.GetValue(0));
            var storage = rows.GetString(1);
            var key = rows.GetString(2);
            if (id == Guid.Empty || !ids.Add(id) || !locators.Add(key) || items.Count == LegacyAssetLimit)
                throw new InvalidOperationException("The legacy asset identity set is ambiguous or exceeds its verification bound.");
            items.Add(new AssetMeta(id, storage, key, rows.GetString(4), rows.GetString(3), AssetInteger(rows.GetValue(5)),
                rows.IsDBNull(6) ? null : rows.GetString(6), NullableAssetInteger(rows, 7), NullableAssetInteger(rows, 8),
                NullableAssetInteger(rows, 9), rows.GetString(10), rows.GetValue(11), rows.GetValue(12)));
        }
        return items.OrderBy(asset => asset.Id).ToArray();
    }

    private static string? CheckAssetMetadata(AssetMeta asset)
    {
        if (asset.State != "active") return asset.State == "pending_delete" ? "asset-pending-delete" : "asset-state-unrecognized";
        if (asset.StorageClass is not ("public" or "private") || !IsLegacyAssetKey(asset.Key) ||
            asset.Bytes is < 0 or > LegacyAssetByteLimit || asset.MediaType.Length is < 1 or > 127 ||
            asset.Extension.Length > 16 || asset.Width is < 1 or > int.MaxValue || asset.Height is < 1 or > int.MaxValue ||
            !IsLegacyAssetTime(asset.Created) || !IsLegacyAssetTime(asset.Updated))
            return "asset-storage-metadata-unrecognized";
        if (asset.Digest is not null && !IsLegacyAssetDigest(asset.Digest))
            return "asset-source-digest-unrecognized";
        if (asset.StorageClass == "private")
        {
            if (asset.Digest is null) return "private-legacy-digest-unavailable";
            var stem = asset.Id.ToString("N");
            var extension = (asset.Extension.StartsWith('.') ? asset.Extension : "." + asset.Extension).ToLowerInvariant();
            if (string.IsNullOrWhiteSpace(asset.Extension) || extension.Length > 16 ||
                !extension.All(character => character == '.' || char.IsAsciiLetterOrDigit(character)) ||
                asset.Key != $"{stem[..2]}/{stem}{extension}")
                return "private-key-mismatch";
        }
        return null;
    }

    private static bool IsLegacyAssetKey(string key) =>
        key.Length is >= 1 and <= 512 && key.Split('/').All(segment =>
            segment.Length is >= 1 and <= 255 && segment is not ("." or "..") &&
            segment.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '_' or '-'));

    private static bool IsLegacyAssetDigest(string? value) => value is { Length: 64 } && value.All(char.IsAsciiHexDigit);

    private static Guid AssetGuid(object value) => value switch
    {
        Guid guid => guid,
        string text when Guid.TryParseExact(text, "D", out var guid) || Guid.TryParseExact(text, "N", out guid) => guid,
        _ => throw new InvalidOperationException("Unsupported v1 asset UUID representation.")
    };

    private static long AssetInteger(object value) => value is int or long or short or sbyte or uint or ulong or ushort
        ? Convert.ToInt64(value, CultureInfo.InvariantCulture)
        : throw new InvalidOperationException("Unsupported v1 asset integer representation.");

    private static long? NullableAssetInteger(DbDataReader row, int ordinal) =>
        row.IsDBNull(ordinal) ? null : AssetInteger(row.GetValue(ordinal));

    private static bool IsLegacyAssetTime(object value) => value is DateTime or DateTimeOffset ||
        value is string text && DateTimeOffset.TryParse(text, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal, out _);

    private static void AppendAssetMetadata(IncrementalHash digest, AssetMeta asset)
    {
        foreach (var value in new object?[] { asset.Id.ToString("D"), asset.StorageClass, asset.Key, asset.MediaType, asset.Extension,
                     asset.Bytes, asset.Digest, asset.Width, asset.Height, asset.Owner, asset.State, asset.Created, asset.Updated })
            AppendLegacyValue(digest, value);
    }
}
