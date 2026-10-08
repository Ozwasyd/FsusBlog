using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>One exact-byte checksum row; the checksum document never contains a row for itself.</summary>
public sealed record ArticlePackageChecksumEntry(string Path, long ByteLength, string Sha256);

/// <summary>
/// Caller-owned actual bytes. ReadOnlyMemory does not freeze its underlying storage: the caller
/// must prevent mutation for the entire operation or provide its own byte copy. This component
/// copies collection entries, not their byte buffers, and performs no archive or filesystem reads.
/// </summary>
public sealed record ArticlePackageFileBytes(string Path, ReadOnlyMemory<byte> Bytes);

/// <summary>
/// A finite checksum-component result, not a package-valid receipt. It proves no manifest schema,
/// privacy policy, dependency mapping, source provenance, ZIP safety or import qualification.
/// </summary>
public readonly record struct ArticlePackageChecksumValidationResult(
    bool IsValid,
    string? ReasonCode,
    string? ComponentDigest)
{
    public static ArticlePackageChecksumValidationResult Invalid(string reasonCode)
        => new(false, reasonCode, null);
}

/// <summary>
/// Owns the closed checksum component and its v1 digest. The document covers manifest, Markdown
/// and assets exactly once. Its own bytes and ZIP metadata are excluded to avoid circularity.
/// Full package semantic validation remains a separate, unimplemented contract.
/// </summary>
public static class ArticlePackageChecksums
{
    public const string Schema = "fsusblog.article-package.checksums.v1";
    public const int Version = 1;
    public const string Algorithm = "sha256-framed-v1";
    public const string DigestDomain = "fsusblog.article-package.checksum-component.v1";

    /// <summary>
    /// Computes the finite component digest from a complete checksum table and validated inventory.
    /// Collections are copied by bounded indexing before validation. This only validates metadata;
    /// Verify must check these rows against actual file bytes.
    /// </summary>
    public static ArticlePackageChecksumValidationResult ComputeComponentDigest(
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        IReadOnlyList<ArticlePackageChecksumEntry>? checksums)
    {
        if (!TryCopy(inventory, ArticlePackageInventory.MaxEntries, out ArticlePackageInventoryEntry[] ownedInventory))
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_inventory_input_invalid");
        }
        ArticlePackageValidationResult inventoryResult = ArticlePackageInventory.Validate(ownedInventory);
        if (!inventoryResult.IsValid)
        {
            return ArticlePackageChecksumValidationResult.Invalid(inventoryResult.ReasonCode!);
        }
        if (!TryCopy(checksums, ownedInventory.Length - 1, out ArticlePackageChecksumEntry[] ownedRows))
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_closure_mismatch");
        }
        ArticlePackageChecksumValidationResult rowsResult = ValidateRows(ownedInventory, ownedRows);
        if (!rowsResult.IsValid)
        {
            return rowsResult;
        }

        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        AppendFrame(hash, Encoding.UTF8.GetBytes(DigestDomain));
        AppendUInt32(hash, Version);
        AppendFrame(hash, Encoding.UTF8.GetBytes(Algorithm));
        AppendUInt32(hash, ownedRows.Length);
        Array.Sort(ownedRows, (left, right) => StringComparer.Ordinal.Compare(left.Path, right.Path));
        Span<byte> length = stackalloc byte[8];
        foreach (ArticlePackageChecksumEntry row in ownedRows)
        {
            AppendFrame(hash, Encoding.UTF8.GetBytes(row.Path));
            BinaryPrimitives.WriteUInt64BigEndian(length, (ulong)row.ByteLength);
            hash.AppendData(length);
            AppendFrame(hash, Convert.FromHexString(row.Sha256));
        }

        return new(true, null, Convert.ToHexStringLower(hash.GetHashAndReset()));
    }

    /// <summary>
    /// Reads the actual checksums.json bytes through an exact, closed v1 decoder and compares every
    /// covered file to its row. Collections are copied by bounded indexing; callers must keep the
    /// underlying byte buffers immutable for this entire operation.
    /// The result does not retain caller bytes or grant full package semantic validity.
    /// </summary>
    public static ArticlePackageChecksumValidationResult Verify(
        IReadOnlyList<ArticlePackageInventoryEntry>? inventory,
        IReadOnlyList<ArticlePackageFileBytes>? files)
    {
        if (!TryCopy(inventory, ArticlePackageInventory.MaxEntries, out ArticlePackageInventoryEntry[] ownedInventory))
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_inventory_input_invalid");
        }
        ArticlePackageValidationResult inventoryResult = ArticlePackageInventory.Validate(ownedInventory);
        if (!inventoryResult.IsValid)
        {
            return ArticlePackageChecksumValidationResult.Invalid(inventoryResult.ReasonCode!);
        }
        if (!TryCopy(files, ownedInventory.Length, out ArticlePackageFileBytes[] ownedFiles)
            || ownedFiles.Length != ownedInventory.Length)
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_file_closure_mismatch");
        }

        Dictionary<string, ArticlePackageInventoryEntry> expectedFiles = ownedInventory.ToDictionary(entry => entry.Path, StringComparer.Ordinal);
        var actualFiles = new Dictionary<string, ArticlePackageFileBytes>(StringComparer.Ordinal);
        foreach (ArticlePackageFileBytes? file in ownedFiles)
        {
            if (file is null || file.Path is null
                || file.Path.Length > ArticlePackageInventory.MaxPathCharacters
                || !expectedFiles.TryGetValue(file.Path, out ArticlePackageInventoryEntry? expected))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_file_closure_mismatch");
            }
            if (!actualFiles.TryAdd(file.Path, file))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_file_duplicate");
            }
            if (file.Bytes.Length != expected.UncompressedBytes)
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_file_length_mismatch");
            }
        }

        ArticlePackageChecksumValidationResult documentResult = ReadDocument(
            actualFiles[ArticlePackageInventory.ChecksumsPath].Bytes,
            ownedInventory.Length - 1,
            out IReadOnlyList<ArticlePackageChecksumEntry>? rows,
            out string? expectedDigest);
        if (!documentResult.IsValid)
        {
            return documentResult;
        }
        ArticlePackageChecksumValidationResult digestResult = ComputeComponentDigest(ownedInventory, rows);
        if (!digestResult.IsValid)
        {
            return digestResult;
        }
        if (!DigestEquals(digestResult.ComponentDigest!, expectedDigest!))
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_component_digest_mismatch");
        }

        foreach (ArticlePackageChecksumEntry row in rows!)
        {
            ReadOnlySpan<byte> bytes = actualFiles[row.Path].Bytes.Span;
            if (row.Path.StartsWith("articles/", StringComparison.Ordinal))
            {
                ArticlePackageByteValidationResult sourceResult = ArticlePackageSourceBytes.Inspect(bytes, out _);
                if (!sourceResult.IsValid)
                {
                    return ArticlePackageChecksumValidationResult.Invalid(sourceResult.ReasonCode!);
                }
            }
            if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(bytes), Convert.FromHexString(row.Sha256)))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_file_digest_mismatch");
            }
        }

        return digestResult;
    }

    private static bool TryCopy<T>(IReadOnlyList<T>? input, int maximum, out T[] owned)
    {
        owned = [];
        if (input is null)
        {
            return false;
        }
        try
        {
            int count = input.Count;
            if (count < 0 || count > maximum)
            {
                return false;
            }
            var copy = new T[count];
            for (int index = 0; index < count; index++)
            {
                copy[index] = input[index];
            }
            owned = copy;
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (IndexOutOfRangeException)
        {
            return false;
        }
    }

    private static ArticlePackageChecksumValidationResult ValidateRows(
        IReadOnlyList<ArticlePackageInventoryEntry> inventory,
        IReadOnlyList<ArticlePackageChecksumEntry>? rows)
    {
        if (rows is null || rows.Count != inventory.Count - 1)
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_closure_mismatch");
        }
        Dictionary<string, ArticlePackageInventoryEntry> expectedFiles = inventory
            .Where(entry => entry.Path != ArticlePackageInventory.ChecksumsPath)
            .ToDictionary(entry => entry.Path, StringComparer.Ordinal);
        var paths = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticlePackageChecksumEntry? row in rows)
        {
            if (row is null || row.Path is null
                || row.Path.Length > ArticlePackageInventory.MaxPathCharacters
                || !expectedFiles.TryGetValue(row.Path, out ArticlePackageInventoryEntry? expected))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_closure_mismatch");
            }
            if (!paths.Add(row.Path))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_duplicate");
            }
            if (row.ByteLength != expected.UncompressedBytes || !IsDigest(row.Sha256))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_row_invalid");
            }
        }

        return new(true, null, null);
    }

    private static ArticlePackageChecksumValidationResult ReadDocument(
        ReadOnlyMemory<byte> bytes,
        int expectedCount,
        out IReadOnlyList<ArticlePackageChecksumEntry>? rows,
        out string? digest)
    {
        rows = null;
        digest = null;
        try
        {
            using JsonDocument document = JsonDocument.Parse(bytes, new JsonDocumentOptions
            {
                MaxDepth = 4,
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow
            });
            JsonElement root = document.RootElement;
            if (!HasExactProperties(root, "schema", "version", "algorithm", "componentDigest", "files")
                || !IsString(root.GetProperty("schema"), Schema)
                || !root.GetProperty("version").TryGetInt32(out int version)
                || version != Version
                || !IsString(root.GetProperty("algorithm"), Algorithm))
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_document_invalid");
            }
            JsonElement digestElement = root.GetProperty("componentDigest");
            JsonElement filesElement = root.GetProperty("files");
            if (digestElement.ValueKind != JsonValueKind.String
                || !IsDigest(digestElement.GetString())
                || filesElement.ValueKind != JsonValueKind.Array
                || filesElement.GetArrayLength() != expectedCount)
            {
                return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_document_invalid");
            }

            var parsedRows = new List<ArticlePackageChecksumEntry>(expectedCount);
            foreach (JsonElement entry in filesElement.EnumerateArray())
            {
                if (!HasExactProperties(entry, "path", "byteLength", "sha256")
                    || entry.GetProperty("path").ValueKind != JsonValueKind.String
                    || entry.GetProperty("sha256").ValueKind != JsonValueKind.String
                    || !entry.GetProperty("byteLength").TryGetInt64(out long byteLength))
                {
                    return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_document_invalid");
                }
                parsedRows.Add(new(entry.GetProperty("path").GetString()!, byteLength, entry.GetProperty("sha256").GetString()!));
            }

            rows = parsedRows.AsReadOnly();
            digest = digestElement.GetString();
            return new(true, null, null);
        }
        catch (JsonException)
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_document_invalid");
        }
        catch (InvalidOperationException)
        {
            return ArticlePackageChecksumValidationResult.Invalid("article_package_checksum_document_invalid");
        }
    }

    private static bool HasExactProperties(JsonElement value, params string[] names)
    {
        if (value.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!names.Contains(property.Name, StringComparer.Ordinal) || !seen.Add(property.Name))
            {
                return false;
            }
        }

        return seen.Count == names.Length;
    }

    private static bool IsString(JsonElement value, string expected)
        => value.ValueKind == JsonValueKind.String && value.GetString() == expected;

    private static bool IsDigest(string? value)
        => value is not null
            && value.Length == 64
            && value.All(character => (character is >= '0' and <= '9') || (character is >= 'a' and <= 'f'));

    private static bool DigestEquals(string left, string right)
        => CryptographicOperations.FixedTimeEquals(Convert.FromHexString(left), Convert.FromHexString(right));

    private static void AppendFrame(IncrementalHash hash, ReadOnlySpan<byte> value)
    {
        AppendUInt32(hash, value.Length);
        hash.AppendData(value);
    }

    private static void AppendUInt32(IncrementalHash hash, int value)
    {
        Span<byte> length = stackalloc byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(length, (uint)value);
        hash.AppendData(length);
    }
}
