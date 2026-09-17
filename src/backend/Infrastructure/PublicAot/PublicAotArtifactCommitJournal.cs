using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal enum PublicAotArtifactCommitState
{
    Staged,
    ArtifactCommitted,
    RegistryCommitted,
    PointerAdvanced,
    Complete,
    RollbackRequired
}

internal sealed record PublicAotArtifactTransaction(
    string Schema,
    string ArtifactId,
    string CacheKey,
    string RelativePath,
    long Generation,
    string PayloadDigest,
    IReadOnlyList<string> RegistryKeys,
    PublicAotArtifactCommitState State,
    DateTimeOffset UpdatedAtUtc,
    string ContentDigest);

internal sealed record PublicAotArtifactPointer(
    string Schema,
    string ArtifactId,
    string CacheKey,
    string RelativePath,
    long Generation,
    string PayloadDigest,
    string TransactionDigest,
    DateTimeOffset UpdatedAtUtc,
    string ContentDigest);

internal sealed record PublicAotArtifactTransactionIdentity(
    string Schema,
    string ArtifactId,
    string CacheKey,
    string RelativePath,
    long Generation,
    string PayloadDigest,
    IReadOnlyList<string> RegistryKeys);

internal sealed record PublicAotOrphanArtifact(
    string Schema,
    string ArtifactId,
    string CacheKey,
    string RelativePath,
    string Reason,
    DateTimeOffset QuarantinedAtUtc,
    string ContentDigest);

internal sealed class PublicAotArtifactCommitJournal
{
    private const string JournalSchema = "fsusblog.public-aot-artifact-transaction.v1";
    private const string OrphanSchema = "fsusblog.public-aot-orphan-artifact.v1";
    private const string PointerSchema = "fsusblog.public-aot-artifact-pointer.v1";

    private static readonly JsonSerializerOptions s_jsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    static PublicAotArtifactCommitJournal()
    {
        s_jsonOptions.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.KebabCaseLower));
    }

    private readonly string _cacheRoot;
    private readonly TimeProvider _timeProvider;

    public PublicAotArtifactCommitJournal(string cacheRoot, TimeProvider timeProvider)
    {
        _cacheRoot = Path.GetFullPath(cacheRoot);
        _timeProvider = timeProvider;
    }

    public string TransactionRoot => Path.Combine(_cacheRoot, ".transactions");

    public string GetArtifactId(string cacheKey) => HashText(cacheKey);

    public string GetStagingPath(string artifactId)
        => Path.Combine(_cacheRoot, ".transaction-stage", $"{ValidateArtifactId(artifactId)}.aeds");

    public async Task<FileStream> AcquireLockAsync(
        string artifactId,
        CancellationToken cancellationToken)
    {
        string lockPath = Path.Combine(
            _cacheRoot,
            ".transaction-locks",
            $"{ValidateArtifactId(artifactId)}.lock");
        Directory.CreateDirectory(Path.GetDirectoryName(lockPath)!);
        DateTimeOffset deadline = _timeProvider.GetUtcNow().AddSeconds(10);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return new FileStream(
                    lockPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.None,
                    bufferSize: 1,
                    FileOptions.Asynchronous | FileOptions.WriteThrough);
            }
            catch (IOException) when (_timeProvider.GetUtcNow() < deadline)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(25), _timeProvider, cancellationToken)
                    .ConfigureAwait(false);
            }
        }
    }

    public PublicAotArtifactTransaction Create(
        string cacheKey,
        string relativePath,
        ReadOnlySpan<byte> payload,
        IReadOnlyList<string> registryKeys)
    {
        string artifactId = GetArtifactId(cacheKey);
        var transaction = new PublicAotArtifactTransaction(
            JournalSchema,
            artifactId,
            cacheKey,
            NormalizeRelativePath(relativePath),
            ParseGeneration(cacheKey),
            Convert.ToHexStringLower(SHA256.HashData(payload)),
            registryKeys.Order(StringComparer.Ordinal).ToArray(),
            PublicAotArtifactCommitState.Staged,
            _timeProvider.GetUtcNow(),
            string.Empty);
        return Seal(transaction);
    }

    public async Task WriteStagingPayloadAsync(
        PublicAotArtifactTransaction transaction,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        string path = GetStagingPath(transaction.ArtifactId);
        await WriteBytesDurablyAsync(path, payload, cancellationToken).ConfigureAwait(false);
    }

    public Task PersistAsync(
        PublicAotArtifactTransaction transaction,
        CancellationToken cancellationToken)
        => WriteJsonDurablyAsync(GetTransactionPath(transaction.ArtifactId), transaction, cancellationToken);

    public async Task<PublicAotArtifactTransaction> AdvanceAsync(
        PublicAotArtifactTransaction transaction,
        PublicAotArtifactCommitState state,
        CancellationToken cancellationToken)
    {
        PublicAotArtifactTransaction advanced = Seal(transaction with
        {
            State = state,
            UpdatedAtUtc = _timeProvider.GetUtcNow(),
            ContentDigest = string.Empty
        });
        await PersistAsync(advanced, cancellationToken).ConfigureAwait(false);
        return advanced;
    }

    public async Task WritePointerAsync(
        PublicAotArtifactTransaction transaction,
        CancellationToken cancellationToken)
    {
        var pointer = new PublicAotArtifactPointer(
            PointerSchema,
            transaction.ArtifactId,
            transaction.CacheKey,
            transaction.RelativePath,
            transaction.Generation,
            transaction.PayloadDigest,
            GetTransactionIdentityDigest(transaction),
            _timeProvider.GetUtcNow(),
            string.Empty);
        pointer = Seal(pointer);
        await WriteJsonDurablyAsync(GetPointerPath(transaction.ArtifactId), pointer, cancellationToken)
            .ConfigureAwait(false);
    }

    public bool TryReadTransaction(string artifactId, out PublicAotArtifactTransaction? transaction)
    {
        if (!TryReadAndValidate(GetTransactionPath(artifactId), Seal, out transaction)
            || !string.Equals(transaction!.Schema, JournalSchema, StringComparison.Ordinal)
            || !string.Equals(transaction.ArtifactId, artifactId, StringComparison.Ordinal)
            || !string.Equals(transaction.ArtifactId, GetArtifactId(transaction.CacheKey), StringComparison.Ordinal)
            || transaction.Generation != ParseGeneration(transaction.CacheKey)
            || !IsSha256(transaction.PayloadDigest)
            || transaction.RegistryKeys.Count == 0
            || transaction.RegistryKeys.Any(string.IsNullOrWhiteSpace))
        {
            transaction = null;
            return false;
        }

        try
        {
            _ = NormalizeRelativePath(transaction.RelativePath);
            return true;
        }
        catch (InvalidOperationException)
        {
            transaction = null;
            return false;
        }
    }

    public bool TryReadTransactionForCacheKey(string cacheKey, out PublicAotArtifactTransaction? transaction)
        => TryReadTransaction(GetArtifactId(cacheKey), out transaction)
            && string.Equals(transaction!.CacheKey, cacheKey, StringComparison.Ordinal);

    public bool TryReadPointer(string artifactId, out PublicAotArtifactPointer? pointer)
    {
        if (!TryReadAndValidate(GetPointerPath(artifactId), Seal, out pointer)
            || !string.Equals(pointer!.Schema, PointerSchema, StringComparison.Ordinal)
            || !string.Equals(pointer.ArtifactId, artifactId, StringComparison.Ordinal)
            || !string.Equals(pointer.ArtifactId, GetArtifactId(pointer.CacheKey), StringComparison.Ordinal)
            || pointer.Generation != ParseGeneration(pointer.CacheKey)
            || !IsSha256(pointer.PayloadDigest)
            || !IsSha256(pointer.TransactionDigest))
        {
            pointer = null;
            return false;
        }

        try
        {
            _ = NormalizeRelativePath(pointer.RelativePath);
            return true;
        }
        catch (InvalidOperationException)
        {
            pointer = null;
            return false;
        }
    }

    public IEnumerable<PublicAotArtifactTransaction> EnumerateTransactions()
    {
        if (!Directory.Exists(TransactionRoot))
        {
            yield break;
        }

        foreach (string path in Directory.EnumerateFiles(TransactionRoot, "*.json", SearchOption.TopDirectoryOnly))
        {
            string artifactId = Path.GetFileNameWithoutExtension(path);
            if (TryReadTransaction(artifactId, out PublicAotArtifactTransaction? transaction))
            {
                yield return transaction!;
            }
        }
    }

    public int RemoveOrphansByPrefix(string prefix)
    {
        string ledgerRoot = Path.Combine(_cacheRoot, ".orphan-ledger");
        if (!Directory.Exists(ledgerRoot))
        {
            return 0;
        }

        int removed = 0;
        foreach (string path in Directory.EnumerateFiles(ledgerRoot, "*.json", SearchOption.TopDirectoryOnly))
        {
            string artifactId = Path.GetFileNameWithoutExtension(path);
            if (!TryReadAndValidate(path, Seal, out PublicAotOrphanArtifact? orphan)
                || !string.Equals(orphan!.Schema, OrphanSchema, StringComparison.Ordinal)
                || !string.Equals(orphan.ArtifactId, artifactId, StringComparison.Ordinal)
                || !string.Equals(orphan.ArtifactId, GetArtifactId(orphan.CacheKey), StringComparison.Ordinal)
                || !orphan!.CacheKey.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            string quarantineRoot = Path.Combine(_cacheRoot, ".orphan-artifacts", artifactId);
            if (Directory.Exists(quarantineRoot))
            {
                Directory.Delete(quarantineRoot, recursive: true);
            }

            File.Delete(path);
            removed++;
        }

        return removed;
    }

    public bool AuthorizesRead(string cacheKey, string relativePath, ReadOnlySpan<byte> payload)
    {
        if (!TryReadTransactionForCacheKey(cacheKey, out PublicAotArtifactTransaction? transaction)
            || transaction!.State != PublicAotArtifactCommitState.Complete
            || !string.Equals(transaction.RelativePath, NormalizeRelativePath(relativePath), StringComparison.Ordinal)
            || !File.Exists(ResolveRelativePath(transaction.RelativePath))
            || !string.Equals(
                transaction.PayloadDigest,
                Convert.ToHexStringLower(SHA256.HashData(payload)),
                StringComparison.Ordinal)
            || transaction.Generation != ParseGeneration(cacheKey)
            || !TryReadPointer(transaction.ArtifactId, out PublicAotArtifactPointer? pointer))
        {
            return false;
        }

        return string.Equals(pointer!.ArtifactId, transaction.ArtifactId, StringComparison.Ordinal)
            && string.Equals(pointer.CacheKey, transaction.CacheKey, StringComparison.Ordinal)
            && string.Equals(pointer.RelativePath, transaction.RelativePath, StringComparison.Ordinal)
            && pointer.Generation == transaction.Generation
            && string.Equals(pointer.PayloadDigest, transaction.PayloadDigest, StringComparison.Ordinal)
            && string.Equals(
                pointer.TransactionDigest,
                GetTransactionIdentityDigest(transaction),
                StringComparison.Ordinal);
    }

    public bool PointerMatches(PublicAotArtifactTransaction transaction)
    {
        return TryReadPointer(transaction.ArtifactId, out PublicAotArtifactPointer? pointer)
            && string.Equals(pointer!.ArtifactId, transaction.ArtifactId, StringComparison.Ordinal)
            && string.Equals(pointer.CacheKey, transaction.CacheKey, StringComparison.Ordinal)
            && string.Equals(pointer.RelativePath, transaction.RelativePath, StringComparison.Ordinal)
            && pointer.Generation == transaction.Generation
            && string.Equals(pointer.PayloadDigest, transaction.PayloadDigest, StringComparison.Ordinal)
            && string.Equals(
                pointer.TransactionDigest,
                GetTransactionIdentityDigest(transaction),
                StringComparison.Ordinal);
    }

    public bool IsActiveTransactionForPath(string relativePath)
    {
        string normalizedPath = NormalizeRelativePath(relativePath);
        return EnumerateTransactions().Any(transaction =>
            string.Equals(transaction.RelativePath, normalizedPath, StringComparison.Ordinal)
            && transaction.State is not PublicAotArtifactCommitState.Complete
                and not PublicAotArtifactCommitState.RollbackRequired);
    }

    public bool IsPointerTarget(string relativePath)
    {
        string normalizedPath = NormalizeRelativePath(relativePath);
        string pointerRoot = Path.Combine(_cacheRoot, ".transaction-pointers");
        if (!Directory.Exists(pointerRoot))
        {
            return false;
        }

        foreach (string path in Directory.EnumerateFiles(pointerRoot, "*.json", SearchOption.TopDirectoryOnly))
        {
            string artifactId = Path.GetFileNameWithoutExtension(path);
            if (TryReadPointer(artifactId, out PublicAotArtifactPointer? pointer)
                && string.Equals(pointer!.RelativePath, normalizedPath, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    public async Task QuarantineAsync(
        string cacheKey,
        string relativePath,
        string reason,
        CancellationToken cancellationToken)
    {
        string normalizedPath = NormalizeRelativePath(relativePath);
        string source = ResolveRelativePath(normalizedPath);
        string artifactId = GetArtifactId(cacheKey);
        if (File.Exists(source))
        {
            string quarantinePath = Path.Combine(
                _cacheRoot,
                ".orphan-artifacts",
                artifactId,
                $"{Guid.NewGuid():N}.aeds");
            Directory.CreateDirectory(Path.GetDirectoryName(quarantinePath)!);
            File.Move(source, quarantinePath);
        }

        var orphan = new PublicAotOrphanArtifact(
            OrphanSchema,
            artifactId,
            cacheKey,
            normalizedPath,
            reason,
            _timeProvider.GetUtcNow(),
            string.Empty);
        orphan = Seal(orphan);
        await WriteJsonDurablyAsync(
            Path.Combine(_cacheRoot, ".orphan-ledger", $"{artifactId}.json"),
            orphan,
            cancellationToken).ConfigureAwait(false);
        if (TryReadTransaction(artifactId, out PublicAotArtifactTransaction? transaction)
            && transaction!.State != PublicAotArtifactCommitState.RollbackRequired)
        {
            _ = await AdvanceAsync(
                transaction,
                PublicAotArtifactCommitState.RollbackRequired,
                cancellationToken).ConfigureAwait(false);
        }
    }

    public void DeleteMetadata(string cacheKey)
    {
        string artifactId = GetArtifactId(cacheKey);
        DeleteMetadataFile(GetTransactionPath(artifactId));
        DeleteMetadataFile(GetPointerPath(artifactId));
        DeleteMetadataFile(GetStagingPath(artifactId));
    }

    private static void DeleteMetadataFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (FileNotFoundException)
        {
        }
        catch (DirectoryNotFoundException)
        {
        }
    }

    public string ResolveRelativePath(string relativePath)
    {
        string normalized = NormalizeRelativePath(relativePath);
        string resolved = Path.GetFullPath(Path.Combine(_cacheRoot, normalized));
        string prefix = Path.TrimEndingDirectorySeparator(_cacheRoot) + Path.DirectorySeparatorChar;
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (!resolved.StartsWith(prefix, comparison))
        {
            throw new InvalidOperationException("Public AOT transaction path escapes the cache root.");
        }

        return resolved;
    }

    public string GetRelativePath(string path)
        => NormalizeRelativePath(Path.GetRelativePath(_cacheRoot, Path.GetFullPath(path)));

    private string GetTransactionPath(string artifactId)
        => Path.Combine(TransactionRoot, $"{ValidateArtifactId(artifactId)}.json");

    private string GetPointerPath(string artifactId)
        => Path.Combine(_cacheRoot, ".transaction-pointers", $"{ValidateArtifactId(artifactId)}.json");

    private static string ValidateArtifactId(string artifactId)
        => artifactId.Length == 64 && artifactId.All(static value => char.IsAsciiHexDigit(value))
            ? artifactId.ToLowerInvariant()
            : throw new InvalidOperationException("Public AOT artifact id is invalid.");

    private static string NormalizeRelativePath(string relativePath)
    {
        string normalized = relativePath.Replace(Path.AltDirectorySeparatorChar, Path.DirectorySeparatorChar);
        if (Path.IsPathRooted(normalized)
            || normalized.Split(Path.DirectorySeparatorChar).Any(static segment => segment is "" or "." or ".."))
        {
            throw new InvalidOperationException("Public AOT transaction relative path is invalid.");
        }

        return normalized;
    }

    private static long ParseGeneration(string cacheKey)
    {
        int marker = cacheKey.LastIndexOf(":iv:", StringComparison.Ordinal);
        return marker >= 0 && long.TryParse(cacheKey.AsSpan(marker + 4), out long generation) && generation >= 0
            ? generation
            : 0;
    }

    private static PublicAotArtifactTransaction Seal(PublicAotArtifactTransaction transaction)
    {
        string digest = HashJson(transaction with
        {
            ContentDigest = string.Empty
        });
        return transaction with
        {
            ContentDigest = digest
        };
    }

    private static PublicAotArtifactPointer Seal(PublicAotArtifactPointer pointer)
    {
        string digest = HashJson(pointer with
        {
            ContentDigest = string.Empty
        });
        return pointer with
        {
            ContentDigest = digest
        };
    }

    private static PublicAotOrphanArtifact Seal(PublicAotOrphanArtifact orphan)
    {
        string digest = HashJson(orphan with
        {
            ContentDigest = string.Empty
        });
        return orphan with
        {
            ContentDigest = digest
        };
    }

    private static string HashText(string value)
        => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    private static string GetTransactionIdentityDigest(PublicAotArtifactTransaction transaction)
        => HashJson(new PublicAotArtifactTransactionIdentity(
            transaction.Schema,
            transaction.ArtifactId,
            transaction.CacheKey,
            transaction.RelativePath,
            transaction.Generation,
            transaction.PayloadDigest,
            transaction.RegistryKeys));

    private static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character));

    private static string HashJson<T>(T value)
        => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value, s_jsonOptions)));

    private static bool TryReadAndValidate<T>(
        string path,
        Func<T, T> seal,
        out T? value)
        where T : class
    {
        value = null;
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            T? parsed = JsonSerializer.Deserialize<T>(File.ReadAllBytes(path), s_jsonOptions);
            if (parsed is null)
            {
                return false;
            }

            T expected = seal(parsed);
            string? storedDigest = parsed switch
            {
                PublicAotArtifactTransaction transaction => transaction.ContentDigest,
                PublicAotArtifactPointer pointer => pointer.ContentDigest,
                PublicAotOrphanArtifact orphan => orphan.ContentDigest,
                _ => null
            };
            string? expectedDigest = expected switch
            {
                PublicAotArtifactTransaction transaction => transaction.ContentDigest,
                PublicAotArtifactPointer pointer => pointer.ContentDigest,
                PublicAotOrphanArtifact orphan => orphan.ContentDigest,
                _ => null
            };
            if (!string.Equals(storedDigest, expectedDigest, StringComparison.Ordinal))
            {
                return false;
            }

            value = parsed;
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return false;
        }
    }

    private static async Task WriteJsonDurablyAsync<T>(
        string path,
        T value,
        CancellationToken cancellationToken)
        => await WriteBytesDurablyAsync(
            path,
            JsonSerializer.SerializeToUtf8Bytes(value, s_jsonOptions),
            cancellationToken).ConfigureAwait(false);

    private static async Task WriteBytesDurablyAsync(
        string path,
        ReadOnlyMemory<byte> value,
        CancellationToken cancellationToken)
    {
        string directory = Path.GetDirectoryName(path)!;
        Directory.CreateDirectory(directory);
        string temporaryPath = Path.Combine(directory, $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(value, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }
}
