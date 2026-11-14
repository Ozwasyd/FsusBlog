using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

internal static partial class Migration
{
    private const int LegacyAssetReferenceLimit = 20_000;

    private sealed record AssetReferenceAudit(long Total, long Articles, long Revisions, long Drafts, string Sha256);

    private static void ValidateLegacyAssetRoots(string publicPath, string privatePath)
    {
        if (publicPath != Path.TrimEndingDirectorySeparator(Path.GetFullPath(publicPath)) ||
            privatePath != Path.TrimEndingDirectorySeparator(Path.GetFullPath(privatePath)) ||
            publicPath == "/" || privatePath == "/" ||
            publicPath.Equals(privatePath, StringComparison.OrdinalIgnoreCase) ||
            publicPath.StartsWith(privatePath + '/', StringComparison.OrdinalIgnoreCase) ||
            privatePath.StartsWith(publicPath + '/', StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("Use separate canonical directories for public and private legacy storage.");
    }

    private static async Task<(string? Digest, string? Failure)> HashLegacyAssetFileAsync(SafeFileHandle root,
        string rootPath, string key, long expected, byte[] buffer, CancellationToken token)
    {
        SafeFileHandle? directory = null;
        var segments = key.Split('/');
        var path = rootPath;
        try
        {
            for (var i = 0; i < segments.Length; i++)
            {
                token.ThrowIfCancellationRequested();
                var part = segments[i];
                // On a case-insensitive snapshot, require the original ordinal spelling too.
                if (OperatingSystem.IsMacOS() && !Directory.EnumerateFileSystemEntries(path, part)
                        .Any(entry => Path.GetFileName(entry).Equals(part, StringComparison.Ordinal)))
                    return (null, "file-unavailable-or-linked");
                if (i == segments.Length - 1) break;
                var next = new SafeFileHandle((nint)OpenImportChild(directory ?? root, part, ImportDirectoryFlags), true);
                if (next.IsInvalid)
                {
                    next.Dispose();
                    return (null, "file-unavailable-or-linked");
                }
                directory?.Dispose();
                directory = next;
                path = Path.Join(path, part);
            }

            var attributes = File.GetAttributes(Path.Join(path, segments[^1]));
            if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory | FileAttributes.Device)) != 0)
                return (null, "file-unavailable-or-linked");
            using var handle = new SafeFileHandle((nint)OpenImportChild(directory ?? root, segments[^1], ImportFileFlags), true);
            if (handle.IsInvalid) return (null, "file-unavailable-or-linked");
            await using var input = new FileStream(handle, FileAccess.Read);
            if (!input.CanSeek || input.Length != expected) return (null, "file-length-mismatch");

            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            long remaining = expected;
            while (remaining > 0)
            {
                var read = await input.ReadAsync(buffer.AsMemory(0, (int)Math.Min(remaining, buffer.Length)), token);
                if (read == 0) return (null, "file-length-mismatch");
                hash.AppendData(buffer.AsSpan(0, read));
                remaining -= read;
            }
            return input.ReadByte() == -1 ? (Convert.ToHexStringLower(hash.GetHashAndReset()), null) : (null, "file-length-mismatch");
        }
        catch (IOException) { return (null, "file-unavailable-or-linked"); }
        catch (UnauthorizedAccessException) { return (null, "file-unavailable-or-linked"); }
        finally { directory?.Dispose(); }
    }

    private static async Task<long?> FindLegacyAssetIdAsync(LegacySource source, DbTransaction transaction,
        LegacyTable table, string column, long id, CancellationToken token)
    {
        await using var command = CreateLegacyCommand(transaction, $"""
            SELECT {source.Field(table, column)} FROM {source.Table(table)} WHERE {source.Field(table, "id")} = @id LIMIT 2
            """);
        var parameter = command.CreateParameter();
        parameter.ParameterName = "id";
        parameter.Value = id;
        command.Parameters.Add(parameter);
        await using var rows = await command.ExecuteReaderAsync(token);
        if (!await rows.ReadAsync(token) || rows.IsDBNull(0)) return null;
        var observed = AssetInteger(rows.GetValue(0));
        return await rows.ReadAsync(token) ? null : observed;
    }

    private sealed record AssetReference(Guid Asset, string Kind, string Key, long? Article, long Count, string? AltText, object Updated);

    private static async Task<AssetReferenceAudit> VerifyAssetReferencesAsync(LegacySource source, DbTransaction transaction,
        LegacyTable table, LegacyTable articles, LegacyTable revisions, IReadOnlyDictionary<Guid, AssetMeta> assets,
        Action<string> addIssue, CancellationToken token)
    {
        await RequireBoundedAssetTextAsync(source, transaction, table,
            [("asset_id", 36), ("source_kind", 16), ("source_key", 640), ("alt_text", 1024), ("updated_at_utc", 64)], token);
        var fields = AssetReferenceColumns.Select(column => source.Field(table, column)).ToArray();
        var references = new List<AssetReference>();
        await using (var command = CreateLegacyCommand(transaction, $"""
            SELECT {string.Join(", ", fields)} FROM {source.Table(table)}
            ORDER BY {string.Join(", ", fields[..3])} LIMIT {LegacyAssetReferenceLimit + 1}
            """))
        await using (var rows = await command.ExecuteReaderAsync(token))
        {
            while (await rows.ReadAsync(token))
            {
                if (references.Count == LegacyAssetReferenceLimit)
                    throw new InvalidOperationException("The legacy reference set exceeds its verification bound.");
                references.Add(new AssetReference(AssetGuid(rows.GetValue(0)), rows.GetString(1), rows.GetString(2),
                    rows.IsDBNull(3) ? null : AssetInteger(rows.GetValue(3)), AssetInteger(rows.GetValue(4)),
                    rows.IsDBNull(5) ? null : rows.GetString(5), rows.GetValue(6)));
            }
        }

        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var column in AssetReferenceColumns) AppendLegacyValue(hash, column);
        var unique = new HashSet<(Guid, string, string)>();
        var existingArticles = new Dictionary<long, bool>();
        var existingRevisions = new Dictionary<long, long?>();
        long current = 0, historical = 0, drafts = 0;
        foreach (var reference in references.OrderBy(item => item.Asset).ThenBy(item => item.Kind, StringComparer.Ordinal)
                     .ThenBy(item => item.Key, StringComparer.Ordinal))
        {
            AppendLegacyValue(hash, reference.Asset.ToString("D"));
            AppendLegacyValue(hash, reference.Kind);
            AppendLegacyValue(hash, reference.Key);
            AppendLegacyValue(hash, reference.Article);
            AppendLegacyValue(hash, reference.Count);
            AppendLegacyValue(hash, reference.AltText);
            AppendLegacyValue(hash, reference.Updated);
            if (!unique.Add((reference.Asset, reference.Kind, reference.Key)) || !assets.ContainsKey(reference.Asset) ||
                reference.Count is < 1 or > int.MaxValue || reference.Key.Length is < 1 or > 160 || reference.AltText?.Length > 256 ||
                !IsLegacyAssetTime(reference.Updated))
            {
                addIssue("reference-identity-or-metadata-invalid");
                continue;
            }

            if (reference.Kind == "draft")
            {
                drafts++;
                addIssue("draft-reference-unsupported");
                continue;
            }
            if (reference.Kind is not ("article" or "revision") || reference.Article is not (> 0 and <= int.MaxValue) ||
                !long.TryParse(reference.Key, NumberStyles.None, CultureInfo.InvariantCulture, out var id) || id <= 0 ||
                id.ToString(CultureInfo.InvariantCulture) != reference.Key)
            {
                addIssue("reference-source-unsupported");
                continue;
            }

            var article = reference.Article.Value;
            if (!existingArticles.TryGetValue(article, out var exists))
            {
                exists = await FindLegacyAssetIdAsync(source, transaction, articles, "id", article, token) == article;
                existingArticles.Add(article, exists);
            }
            if (reference.Kind == "article")
            {
                if (exists && id == article) current++;
                else addIssue("article-reference-unresolved");
                continue;
            }
            if (!existingRevisions.TryGetValue(id, out var revisionArticle))
            {
                revisionArticle = await FindLegacyAssetIdAsync(source, transaction, revisions, "article_id", id, token);
                existingRevisions.Add(id, revisionArticle);
            }
            if (exists && revisionArticle == article) historical++;
            else addIssue("revision-reference-unresolved");
        }
        return new AssetReferenceAudit(references.Count, current, historical, drafts, Convert.ToHexStringLower(hash.GetHashAndReset()));
    }

    private static async Task RequireBoundedAssetTextAsync(LegacySource source, DbTransaction transaction, LegacyTable table,
        (string Column, int Bytes)[] columns, CancellationToken token)
    {
        var checks = columns.Where(column => source.Provider == "sqlite" ||
            (column.Column is not ("id" or "asset_id" or "created_at_utc" or "updated_at_utc") ||
             !IsNativeAssetType(source, table, column.Column)));
        var where = checks.Select(column => $"{source.Utf8Length(source.Field(table, column.Column))} > {column.Bytes}");
        if (await CountAsync($"FROM {source.Table(table)} WHERE {string.Join(" OR ", where)}", transaction, token) != 0)
            throw new InvalidOperationException("The legacy asset text fields exceed their verification bound.");
    }

    private static bool IsNativeAssetType(LegacySource source, LegacyTable table, string column)
    {
        var type = table.Columns.Single(field => field.Name.Equals(column, StringComparison.OrdinalIgnoreCase)).Type;
        return source.Provider == "postgres" && (type == "uuid" || type.StartsWith("timestamp", StringComparison.Ordinal)) ||
            source.Provider == "mysql" && (type.StartsWith("datetime", StringComparison.Ordinal) ||
                type.StartsWith("timestamp", StringComparison.Ordinal));
    }
}
