namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Closed archive entry kinds. Only regular files can belong to a package inventory.</summary>
public enum ArticlePackageEntryKind : byte
{
    RegularFile = 1,
    Directory = 2,
    SymbolicLink = 3,
    HardLink = 4,
    Other = 5
}

/// <summary>
/// Inventory facts supplied by a future archive reader, not proof of bytes read. The reader must
/// enforce these budgets during decompression and verify sizes against actual bytes separately.
/// </summary>
public sealed record ArticlePackageInventoryEntry(
    string Path,
    ArticlePackageEntryKind Kind,
    long UncompressedBytes,
    long CompressedBytes);

/// <summary>
/// Sole closed layout and bounded inventory validation for article packages. This contract does
/// not read ZIPs, bind manifest references, validate MIME or establish a semantic content digest.
/// </summary>
public static class ArticlePackageInventory
{
    public const string ManifestPath = "manifest.json";
    public const string ChecksumsPath = "checksums.json";
    public const int MaxArticles = 10000;
    public const int MaxAssets = 20000;
    public const int MaxEntries = MaxArticles + MaxAssets + 2;
    public const int MaxPathCharacters = 128;
    public const int MaxPathDepth = 2;
    public const int MaxExtensionCharacters = 16;
    public const int MaxFileNameCharacters = 36 + 1 + MaxExtensionCharacters;
    public const long MaxAssetBytes = 512L * 1024 * 1024;
    public const long MaxMetadataBytes = 64L * 1024 * 1024;
    public const long MaxTotalBytes = 8L * 1024 * 1024 * 1024;
    public const long MaxCompressionRatio = 100;

    public static ArticlePackageValidationResult Validate(
        IReadOnlyList<ArticlePackageInventoryEntry>? entries)
    {
        if (entries is null || entries.Count < 3)
        {
            return Invalid(ArticlePackageErrorCode.MissingRequiredEntry, "article_package_inventory_missing");
        }
        if (entries.Count > MaxEntries)
        {
            return Invalid(ArticlePackageErrorCode.BudgetExceeded, "article_package_entry_count_exceeded");
        }

        var paths = new HashSet<string>(StringComparer.Ordinal);
        var articleIdentities = new HashSet<string>(StringComparer.Ordinal);
        var assetIdentities = new HashSet<string>(StringComparer.Ordinal);
        long totalBytes = 0;
        long totalCompressedBytes = 0;
        bool hasManifest = false;
        bool hasChecksums = false;
        foreach (ArticlePackageInventoryEntry? entry in entries)
        {
            if (entry is null || entry.Kind != ArticlePackageEntryKind.RegularFile)
            {
                return Invalid(ArticlePackageErrorCode.NonRegularEntry, "article_package_entry_not_regular");
            }
            ArticlePackageValidationResult pathResult = ValidatePath(entry.Path, out EntryRole role, out string? token);
            if (!pathResult.IsValid)
            {
                return pathResult;
            }
            if (!paths.Add(entry.Path))
            {
                return Invalid(ArticlePackageErrorCode.DuplicatePath, "article_package_path_duplicate");
            }

            long entryLimit;
            switch (role)
            {
                case EntryRole.Manifest:
                    hasManifest = true;
                    entryLimit = MaxMetadataBytes;
                    break;
                case EntryRole.Checksums:
                    hasChecksums = true;
                    entryLimit = MaxMetadataBytes;
                    break;
                case EntryRole.Article:
                    articleIdentities.Add(token!);
                    if (articleIdentities.Count > MaxArticles)
                    {
                        return Invalid(ArticlePackageErrorCode.BudgetExceeded, "article_package_article_count_exceeded");
                    }
                    entryLimit = ArticlePackageSourceBytes.MaximumByteLength;
                    break;
                case EntryRole.Asset:
                    if (!assetIdentities.Add(token!))
                    {
                        return Invalid(ArticlePackageErrorCode.DuplicateIdentity, "article_package_asset_identity_duplicate");
                    }
                    if (assetIdentities.Count > MaxAssets)
                    {
                        return Invalid(ArticlePackageErrorCode.BudgetExceeded, "article_package_asset_count_exceeded");
                    }
                    entryLimit = MaxAssetBytes;
                    break;
                default:
                    return Invalid(ArticlePackageErrorCode.UnknownPath, "article_package_path_unknown");
            }

            if (entry.UncompressedBytes < 0 || entry.CompressedBytes < 0
                || entry.UncompressedBytes > 0 && entry.CompressedBytes == 0)
            {
                return Invalid(ArticlePackageErrorCode.InvalidSize, "article_package_size_invalid");
            }
            if (entry.UncompressedBytes > entryLimit || entry.CompressedBytes > entryLimit)
            {
                return Invalid(ArticlePackageErrorCode.BudgetExceeded, "article_package_entry_bytes_exceeded");
            }
            // Both lengths are bounded above before multiplication; no attacker-sized arithmetic can overflow.
            if (entry.UncompressedBytes > entry.CompressedBytes * MaxCompressionRatio)
            {
                return Invalid(ArticlePackageErrorCode.BudgetExceeded, "article_package_compression_ratio_exceeded");
            }
            if (entry.UncompressedBytes > MaxTotalBytes - totalBytes
                || entry.CompressedBytes > MaxTotalBytes - totalCompressedBytes)
            {
                return Invalid(ArticlePackageErrorCode.BudgetExceeded, "article_package_total_bytes_exceeded");
            }
            totalBytes += entry.UncompressedBytes;
            totalCompressedBytes += entry.CompressedBytes;
        }

        return hasManifest && hasChecksums && articleIdentities.Count > 0
            ? ArticlePackageValidationResult.Valid()
            : Invalid(ArticlePackageErrorCode.MissingRequiredEntry, "article_package_required_entry_missing");
    }

    private static ArticlePackageValidationResult ValidatePath(
        string? path,
        out EntryRole role,
        out string? token)
    {
        role = default;
        token = null;
        if (string.IsNullOrEmpty(path) || path.Length > MaxPathCharacters)
        {
            return Invalid(ArticlePackageErrorCode.UnsafePath, "article_package_path_length_invalid");
        }
        // ASCII-only canonical spellings reject case/Unicode aliases instead of repairing untrusted paths.
        foreach (char character in path)
        {
            if (!((character is >= 'a' and <= 'z')
                || (character is >= '0' and <= '9')
                || character is '/' or '-' or '.'))
            {
                return Invalid(ArticlePackageErrorCode.UnsafePath, "article_package_path_noncanonical");
            }
        }
        string[] segments = path.Split('/');
        if (segments.Length > MaxPathDepth || segments.Any(segment => segment is "" or "." or ".."))
        {
            return Invalid(ArticlePackageErrorCode.UnsafePath, "article_package_path_structure_invalid");
        }
        if (segments.Any(segment => segment.Length > MaxFileNameCharacters))
        {
            return Invalid(ArticlePackageErrorCode.UnsafePath, "article_package_path_name_exceeded");
        }
        if (path == ManifestPath || path == ChecksumsPath)
        {
            role = path == ManifestPath ? EntryRole.Manifest : EntryRole.Checksums;
            return ArticlePackageValidationResult.Valid();
        }
        if (segments.Length != 2)
        {
            return Invalid(ArticlePackageErrorCode.UnknownPath, "article_package_path_unknown");
        }

        string fileName = segments[1];
        int separator = fileName.LastIndexOf('.');
        if (separator < 0 || !ArticlePackageIdentity.IsCanonicalToken(fileName[..separator]))
        {
            return Invalid(ArticlePackageErrorCode.UnknownPath, "article_package_path_unknown");
        }
        token = fileName[..separator];
        string extension = fileName[(separator + 1)..];
        if (segments[0] == "articles" && extension == "md")
        {
            role = EntryRole.Article;
            return ArticlePackageValidationResult.Valid();
        }
        if (segments[0] == "assets"
            && extension.Length is >= 1 and <= MaxExtensionCharacters
            && extension.All(character => (character is >= 'a' and <= 'z') || (character is >= '0' and <= '9')))
        {
            role = EntryRole.Asset;
            return ArticlePackageValidationResult.Valid();
        }

        return Invalid(ArticlePackageErrorCode.UnknownPath, "article_package_path_unknown");
    }

    private static ArticlePackageValidationResult Invalid(ArticlePackageErrorCode code, string reason)
        => ArticlePackageValidationResult.Invalid(code, reason);

    private enum EntryRole : byte
    {
        Manifest = 1,
        Checksums = 2,
        Article = 3,
        Asset = 4
    }
}
