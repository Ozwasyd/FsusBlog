using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Storage;

public sealed record ReleaseDerivedArtifactFile(string Path, string Sha256, long Bytes);

public sealed record ReleaseDerivedArtifactGeneration(
    string Schema,
    string ReleaseId,
    string Kind,
    string Generation,
    IReadOnlyList<ReleaseDerivedArtifactFile> Files);

/// <summary>
/// Publishes a complete derived-artifact generation using stage + directory rename,
/// then atomically advances a release-local pointer. Old generations are retained
/// until the explicit release GC policy removes the whole protected release.
/// </summary>
public sealed class ReleaseDerivedArtifactPublisher
{
    private const string GenerationSchema = "fsusblog.release-derived-generation.v1";
    private static readonly TimeSpan DefaultLockTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan DefaultLockRetryDelay = TimeSpan.FromMilliseconds(25);

    private readonly string _releaseId;
    private readonly Func<string, string> _resolveKindRoot;
    private readonly Action<string> _ensureReleaseDerivedTarget;
    private readonly TimeSpan _lockTimeout;
    private readonly TimeSpan _lockRetryDelay;

    public ReleaseDerivedArtifactPublisher(
        ReleaseStorageLayout layout,
        TimeSpan? publicationLockTimeout = null,
        TimeSpan? publicationLockRetryDelay = null)
    {
        ArgumentNullException.ThrowIfNull(layout);
        _releaseId = layout.ReleaseId;
        _resolveKindRoot = layout.GetReleaseDerivedPath;
        _ensureReleaseDerivedTarget = layout.EnsureReleaseDerivedCleanupTarget;
        (_lockTimeout, _lockRetryDelay) = NormalizeLockTiming(publicationLockTimeout, publicationLockRetryDelay);
    }

    public ReleaseDerivedArtifactPublisher(
        string releaseDerivedBase,
        string releaseId,
        TimeSpan? publicationLockTimeout = null,
        TimeSpan? publicationLockRetryDelay = null)
    {
        string searchRoot = ReleaseStorageLayout.BuildReleaseDerivedPath(releaseDerivedBase, releaseId, "search");
        string releaseRoot = Directory.GetParent(searchRoot)?.FullName
            ?? throw new InvalidOperationException("Unable to resolve the release-derived publication root.");
        _releaseId = Path.GetFileName(releaseRoot);
        _resolveKindRoot = kind => ReleaseStorageLayout.BuildReleaseDerivedPath(releaseDerivedBase, _releaseId, kind);
        _ensureReleaseDerivedTarget = candidate => EnsureReleaseDerivedTarget(releaseRoot, candidate);
        (_lockTimeout, _lockRetryDelay) = NormalizeLockTiming(publicationLockTimeout, publicationLockRetryDelay);
    }

    public string ReleaseId => _releaseId;

    public string GetKindRoot(string kind) => _resolveKindRoot(kind);

    internal string GetKindPublicationLockPath(string kind)
        => Path.Combine(GetKindRoot(kind), ".publication.lock");

    internal string GetArtifactPointerPath(string kind, string relativePath)
        => Path.Combine(GetKindRoot(kind), ".pointers", $"{BuildArtifactId(relativePath)}.json");

    internal string GetArtifactGenerationRoot(string kind, string relativePath, string generation)
        => Path.Combine(
            GetKindRoot(kind),
            ".artifacts",
            BuildArtifactId(relativePath),
            "generations",
            NormalizeGeneration(generation));

    internal string GetArtifactPublicationLockPath(string kind, string relativePath)
        => Path.Combine(GetKindRoot(kind), ".locks", $"{BuildArtifactId(relativePath)}.lock");

    public Task<ReleaseDerivedArtifactGeneration> PublishGenerationAsync(
        string kind,
        string generation,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files,
        CancellationToken cancellationToken = default)
        => PublishKindGenerationCoreAsync(
            kind,
            generation,
            files,
            compatibilityCommitLastPaths: null,
            cancellationToken);

    /// <summary>
    /// Publishes an immutable kind-level generation, projects the legacy read
    /// paths with commit markers last, and advances <c>current.json</c>. The whole
    /// visible commit is serialized by a release-and-kind scoped file lock.
    /// </summary>
    public Task<ReleaseDerivedArtifactGeneration> PublishGenerationAndProjectAsync(
        string kind,
        string generation,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files,
        IReadOnlyCollection<string> compatibilityCommitLastPaths,
        CancellationToken cancellationToken = default)
        => PublishKindGenerationCoreAsync(
            kind,
            generation,
            files,
            compatibilityCommitLastPaths,
            cancellationToken);

    public async Task<ReleaseDerivedArtifactGeneration> ReactivateGenerationAsync(
        string kind,
        string generation,
        IReadOnlyCollection<string> compatibilityCommitLastPaths,
        CancellationToken cancellationToken = default)
    {
        string normalizedGeneration = NormalizeGeneration(generation);
        string kindRoot = GetKindRoot(kind);
        string generationRoot = Path.Combine(kindRoot, "generations", normalizedGeneration);
        _ensureReleaseDerivedTarget(generationRoot);

        await using FileStream publicationLock = await AcquirePublicationLockAsync(
            GetKindPublicationLockPath(kind),
            cancellationToken).ConfigureAwait(false);
        ReleaseDerivedArtifactGeneration stored = ReadAndValidateStoredGeneration(
            generationRoot,
            kind,
            normalizedGeneration);
        await ProjectCompatibilityAliasesAsync(
            kindRoot,
            generationRoot,
            stored,
            compatibilityCommitLastPaths,
            cancellationToken).ConfigureAwait(false);
        await AdvanceKindPointerAsync(kindRoot, stored, cancellationToken).ConfigureAwait(false);
        return stored;
    }

    /// <summary>
    /// Publishes one independently mutable artifact. Its generations, pointer and
    /// lock are scoped by the normalized compatibility-path hash, so unrelated
    /// PublicAOT cache keys cannot overwrite one another's rollback identity.
    /// </summary>
    public async Task<ReleaseDerivedArtifactGeneration> PublishArtifactAndProjectAsync(
        string kind,
        string relativePath,
        string generation,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken = default)
    {
        string normalizedPath = NormalizeRelativePath(relativePath);
        EnsurePublicationPathIsNotReserved(normalizedPath);
        string normalizedGeneration = NormalizeGeneration(generation);
        string kindRoot = GetKindRoot(kind);
        string artifactRoot = Path.Combine(kindRoot, ".artifacts", BuildArtifactId(normalizedPath));
        string generationRoot = Path.Combine(artifactRoot, "generations", normalizedGeneration);
        _ensureReleaseDerivedTarget(generationRoot);
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files =
            new Dictionary<string, ReadOnlyMemory<byte>>(PathComparer) { [normalizedPath] = payload };
        ReleaseDerivedArtifactGeneration manifest = BuildManifest(kind, normalizedGeneration, files);
        string stagingRoot = await StageGenerationAsync(
            artifactRoot,
            normalizedGeneration,
            files,
            manifest,
            cancellationToken).ConfigureAwait(false);

        try
        {
            await using FileStream publicationLock = await AcquirePublicationLockAsync(
                GetArtifactPublicationLockPath(kind, normalizedPath),
                cancellationToken).ConfigureAwait(false);
            CommitOrValidateGeneration(stagingRoot, generationRoot, manifest);
            await ProjectCompatibilityAliasesAsync(
                kindRoot,
                generationRoot,
                manifest,
                [normalizedPath],
                cancellationToken).ConfigureAwait(false);
            await AdvanceArtifactPointerAsync(
                GetArtifactPointerPath(kind, normalizedPath),
                normalizedPath,
                manifest,
                cancellationToken).ConfigureAwait(false);
            return manifest;
        }
        finally
        {
            DeleteStagingDirectory(stagingRoot);
        }
    }

    public async Task<ReleaseDerivedArtifactGeneration> ReactivateArtifactAsync(
        string kind,
        string relativePath,
        string generation,
        CancellationToken cancellationToken = default)
    {
        string normalizedPath = NormalizeRelativePath(relativePath);
        EnsurePublicationPathIsNotReserved(normalizedPath);
        string normalizedGeneration = NormalizeGeneration(generation);
        string kindRoot = GetKindRoot(kind);
        string generationRoot = GetArtifactGenerationRoot(kind, normalizedPath, normalizedGeneration);
        _ensureReleaseDerivedTarget(generationRoot);

        await using FileStream publicationLock = await AcquirePublicationLockAsync(
            GetArtifactPublicationLockPath(kind, normalizedPath),
            cancellationToken).ConfigureAwait(false);
        ReleaseDerivedArtifactGeneration stored = ReadAndValidateStoredGeneration(
            generationRoot,
            kind,
            normalizedGeneration,
            normalizedPath);
        await ProjectCompatibilityAliasesAsync(
            kindRoot,
            generationRoot,
            stored,
            [normalizedPath],
            cancellationToken).ConfigureAwait(false);
        await AdvanceArtifactPointerAsync(
            GetArtifactPointerPath(kind, normalizedPath),
            normalizedPath,
            stored,
            cancellationToken).ConfigureAwait(false);
        return stored;
    }

    public async Task<bool> RemoveArtifactProjectionAsync(
        string kind,
        string relativePath,
        CancellationToken cancellationToken = default)
    {
        string normalizedPath = NormalizeRelativePath(relativePath);
        EnsurePublicationPathIsNotReserved(normalizedPath);
        string kindRoot = GetKindRoot(kind);
        string compatibilityPath = ResolveRelativePath(kindRoot, normalizedPath);

        await using FileStream publicationLock = await AcquirePublicationLockAsync(
            GetArtifactPublicationLockPath(kind, normalizedPath),
            cancellationToken).ConfigureAwait(false);
        bool existed = File.Exists(compatibilityPath);
        if (existed)
        {
            File.Delete(compatibilityPath);
        }

        File.Delete(GetArtifactPointerPath(kind, normalizedPath));
        return existed;
    }

    private async Task<ReleaseDerivedArtifactGeneration> PublishKindGenerationCoreAsync(
        string kind,
        string generation,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files,
        IReadOnlyCollection<string>? compatibilityCommitLastPaths,
        CancellationToken cancellationToken)
    {
        if (files.Count == 0)
        {
            throw new ArgumentException("A derived artifact generation cannot be empty.", nameof(files));
        }

        string normalizedGeneration = NormalizeGeneration(generation);
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> normalizedFiles = NormalizeFiles(files);
        string kindRoot = GetKindRoot(kind);
        string generationRoot = Path.Combine(kindRoot, "generations", normalizedGeneration);
        _ensureReleaseDerivedTarget(generationRoot);
        ReleaseDerivedArtifactGeneration manifest = BuildManifest(kind, normalizedGeneration, normalizedFiles);
        string stagingRoot = await StageGenerationAsync(
            kindRoot,
            normalizedGeneration,
            normalizedFiles,
            manifest,
            cancellationToken).ConfigureAwait(false);

        try
        {
            await using FileStream publicationLock = await AcquirePublicationLockAsync(
                GetKindPublicationLockPath(kind),
                cancellationToken).ConfigureAwait(false);
            CommitOrValidateGeneration(stagingRoot, generationRoot, manifest);
            if (compatibilityCommitLastPaths is not null)
            {
                await ProjectCompatibilityAliasesAsync(
                    kindRoot,
                    generationRoot,
                    manifest,
                    compatibilityCommitLastPaths,
                    cancellationToken).ConfigureAwait(false);
            }

            await AdvanceKindPointerAsync(kindRoot, manifest, cancellationToken).ConfigureAwait(false);
            return manifest;
        }
        finally
        {
            DeleteStagingDirectory(stagingRoot);
        }
    }

    private async Task<string> StageGenerationAsync(
        string publicationRoot,
        string generation,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files,
        ReleaseDerivedArtifactGeneration manifest,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(publicationRoot);
        string stagingRoot = Path.Combine(publicationRoot, $".staging-{generation}-{Guid.NewGuid():N}");
        _ensureReleaseDerivedTarget(stagingRoot);
        Directory.CreateDirectory(stagingRoot);
        try
        {
            foreach ((string relativePath, ReadOnlyMemory<byte> payload) in files.OrderBy(static pair => pair.Key, StringComparer.Ordinal))
            {
                string target = ResolveRelativePath(stagingRoot, relativePath);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                await WriteBytesDurablyAsync(target, payload, cancellationToken).ConfigureAwait(false);
            }

            await WriteJsonDurablyAsync(
                Path.Combine(stagingRoot, "generation-manifest.json"),
                manifest,
                cancellationToken).ConfigureAwait(false);
            return stagingRoot;
        }
        catch
        {
            DeleteStagingDirectory(stagingRoot);
            throw;
        }
    }

    private static void CommitOrValidateGeneration(
        string stagingRoot,
        string generationRoot,
        ReleaseDerivedArtifactGeneration expected)
    {
        if (!Directory.Exists(generationRoot))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(generationRoot)!);
            try
            {
                Directory.Move(stagingRoot, generationRoot);
            }
            catch (IOException) when (Directory.Exists(generationRoot))
            {
                EnsureExistingGenerationMatches(generationRoot, expected);
            }
        }
        else
        {
            EnsureExistingGenerationMatches(generationRoot, expected);
        }
    }

    private ReleaseDerivedArtifactGeneration BuildManifest(
        string kind,
        string generation,
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files)
    {
        ReleaseDerivedArtifactFile[] manifestFiles = files
            .OrderBy(static pair => pair.Key, StringComparer.Ordinal)
            .Select(pair => new ReleaseDerivedArtifactFile(
                NormalizeRelativePath(pair.Key),
                $"sha256:{Convert.ToHexStringLower(SHA256.HashData(pair.Value.Span))}",
                pair.Value.Length))
            .ToArray();
        return new ReleaseDerivedArtifactGeneration(
            GenerationSchema,
            _releaseId,
            kind,
            generation,
            manifestFiles);
    }

    private static IReadOnlyDictionary<string, ReadOnlyMemory<byte>> NormalizeFiles(
        IReadOnlyDictionary<string, ReadOnlyMemory<byte>> files)
    {
        var normalized = new Dictionary<string, ReadOnlyMemory<byte>>(PathComparer);
        foreach ((string relativePath, ReadOnlyMemory<byte> payload) in files)
        {
            string path = NormalizeRelativePath(relativePath);
            EnsurePublicationPathIsNotReserved(path);
            if (!normalized.TryAdd(path, payload))
            {
                throw new ArgumentException($"Derived artifact generation contains a duplicate path: {relativePath}", nameof(files));
            }
        }

        return normalized;
    }

    private ReleaseDerivedArtifactGeneration ReadAndValidateStoredGeneration(
        string generationRoot,
        string expectedKind,
        string expectedGeneration,
        string? expectedSinglePath = null)
    {
        string manifestPath = Path.Combine(generationRoot, "generation-manifest.json");
        ReleaseDerivedArtifactGeneration? stored = File.Exists(manifestPath)
            ? JsonSerializer.Deserialize<ReleaseDerivedArtifactGeneration>(File.ReadAllBytes(manifestPath))
            : null;
        if (stored is null
            || stored.Schema != GenerationSchema
            || stored.ReleaseId != _releaseId
            || stored.Kind != expectedKind
            || stored.Generation != expectedGeneration
            || (expectedSinglePath is not null
                && (stored.Files.Count != 1 || !PathComparer.Equals(stored.Files[0].Path, expectedSinglePath))))
        {
            throw new InvalidOperationException("Stored release-derived generation identity is invalid.");
        }

        EnsureExistingGenerationMatches(generationRoot, stored);
        return stored;
    }

    private static async Task ProjectCompatibilityAliasesAsync(
        string kindRoot,
        string generationRoot,
        ReleaseDerivedArtifactGeneration generation,
        IReadOnlyCollection<string> commitLastPaths,
        CancellationToken cancellationToken)
    {
        var commitLast = new HashSet<string>(PathComparer);
        foreach (string relativePath in commitLastPaths)
        {
            string normalized = NormalizeRelativePath(relativePath);
            EnsurePublicationPathIsNotReserved(normalized);
            if (!generation.Files.Any(file => PathComparer.Equals(file.Path, normalized)))
            {
                throw new ArgumentException(
                    $"Compatibility commit path is not part of the generation: {relativePath}",
                    nameof(commitLastPaths));
            }

            commitLast.Add(normalized);
        }

        foreach (ReleaseDerivedArtifactFile file in generation.Files
                     .OrderBy(file => commitLast.Contains(file.Path) ? 1 : 0)
                     .ThenBy(static file => file.Path, StringComparer.Ordinal))
        {
            string sourcePath = ResolveRelativePath(generationRoot, file.Path);
            string targetPath = ResolveRelativePath(kindRoot, file.Path);
            await CopyFileAtomicallyAsync(sourcePath, targetPath, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task CopyFileAtomicallyAsync(
        string sourcePath,
        string targetPath,
        CancellationToken cancellationToken)
    {
        string targetDirectory = Path.GetDirectoryName(targetPath)!;
        Directory.CreateDirectory(targetDirectory);
        string temporaryPath = Path.Combine(targetDirectory, $".{Path.GetFileName(targetPath)}-{Guid.NewGuid():N}.tmp");
        try
        {
            await using (FileStream source = new(sourcePath, new FileStreamOptions
            {
                Mode = FileMode.Open,
                Access = FileAccess.Read,
                Share = FileShare.Read,
                BufferSize = 81920,
                Options = FileOptions.Asynchronous | FileOptions.SequentialScan
            }))
            await using (FileStream target = new(temporaryPath, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                BufferSize = 81920,
                Options = FileOptions.Asynchronous | FileOptions.WriteThrough
            }))
            {
                await source.CopyToAsync(target, cancellationToken).ConfigureAwait(false);
                await target.FlushAsync(cancellationToken).ConfigureAwait(false);
                target.Flush(flushToDisk: true);
            }

            File.Move(temporaryPath, targetPath, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private static void EnsureExistingGenerationMatches(
        string generationRoot,
        ReleaseDerivedArtifactGeneration expected)
    {
        string manifestPath = Path.Combine(generationRoot, "generation-manifest.json");
        ReleaseDerivedArtifactGeneration? existing = File.Exists(manifestPath)
            ? JsonSerializer.Deserialize<ReleaseDerivedArtifactGeneration>(File.ReadAllBytes(manifestPath))
            : null;
        if (existing is null
            || existing.Schema != expected.Schema
            || existing.ReleaseId != expected.ReleaseId
            || existing.Kind != expected.Kind
            || existing.Generation != expected.Generation
            || !existing.Files.SequenceEqual(expected.Files))
        {
            throw new InvalidOperationException("Derived artifact generation already exists with different content.");
        }

        foreach (ReleaseDerivedArtifactFile file in existing.Files)
        {
            string path = ResolveRelativePath(generationRoot, file.Path);
            if (!File.Exists(path))
            {
                throw new InvalidOperationException($"Derived artifact is missing from existing generation: {file.Path}");
            }

            byte[] payload = File.ReadAllBytes(path);
            string actual = $"sha256:{Convert.ToHexStringLower(SHA256.HashData(payload))}";
            if (payload.LongLength != file.Bytes || !string.Equals(actual, file.Sha256, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"Derived artifact hash mismatch in existing generation: {file.Path}");
            }
        }
    }

    private static Task AdvanceKindPointerAsync(
        string kindRoot,
        ReleaseDerivedArtifactGeneration generation,
        CancellationToken cancellationToken)
        => WritePointerAtomicallyAsync(
            Path.Combine(kindRoot, "current.json"),
            new
            {
                schema = "fsusblog.release-derived-pointer.v1",
                generation.ReleaseId,
                generation.Kind,
                generation.Generation
            },
            cancellationToken);

    private static Task AdvanceArtifactPointerAsync(
        string pointerPath,
        string artifactPath,
        ReleaseDerivedArtifactGeneration generation,
        CancellationToken cancellationToken)
        => WritePointerAtomicallyAsync(
            pointerPath,
            new
            {
                schema = "fsusblog.release-derived-artifact-pointer.v1",
                generation.ReleaseId,
                generation.Kind,
                ArtifactPath = artifactPath.Replace(Path.DirectorySeparatorChar, '/'),
                generation.Generation
            },
            cancellationToken);

    private static async Task WritePointerAtomicallyAsync<T>(
        string pointerPath,
        T value,
        CancellationToken cancellationToken)
    {
        string directory = Path.GetDirectoryName(pointerPath)!;
        Directory.CreateDirectory(directory);
        string temporaryPath = Path.Combine(directory, $".pointer-{Guid.NewGuid():N}.tmp");
        try
        {
            await WriteJsonDurablyAsync(temporaryPath, value, cancellationToken).ConfigureAwait(false);
            File.Move(temporaryPath, pointerPath, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private async Task<FileStream> AcquirePublicationLockAsync(
        string lockPath,
        CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(lockPath)!);
        long started = Stopwatch.GetTimestamp();
        IOException? lastFailure = null;
        while (Stopwatch.GetElapsedTime(started) < _lockTimeout)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                return new FileStream(lockPath, new FileStreamOptions
                {
                    Mode = FileMode.OpenOrCreate,
                    Access = FileAccess.ReadWrite,
                    Share = FileShare.None,
                    BufferSize = 1,
                    Options = FileOptions.WriteThrough
                });
            }
            catch (IOException ex)
            {
                lastFailure = ex;
            }

            TimeSpan remaining = _lockTimeout - Stopwatch.GetElapsedTime(started);
            if (remaining <= TimeSpan.Zero)
            {
                break;
            }

            await Task.Delay(remaining < _lockRetryDelay ? remaining : _lockRetryDelay, cancellationToken)
                .ConfigureAwait(false);
        }

        throw new TimeoutException(
            $"Timed out acquiring release-derived publication lock: {lockPath}",
            lastFailure);
    }

    private static async Task WriteBytesDurablyAsync(
        string path,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            BufferSize = 81920,
            Options = FileOptions.Asynchronous | FileOptions.WriteThrough
        });
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(flushToDisk: true);
    }

    private static async Task WriteJsonDurablyAsync<T>(
        string path,
        T value,
        CancellationToken cancellationToken)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(value);
        await WriteBytesDurablyAsync(path, payload, cancellationToken).ConfigureAwait(false);
    }

    private static string BuildArtifactId(string relativePath)
    {
        string normalized = NormalizeRelativePath(relativePath)
            .Replace(Path.DirectorySeparatorChar, '/');
        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
    }

    private static string NormalizeGeneration(string generation)
    {
        if (string.IsNullOrWhiteSpace(generation)
            || generation.Length > 128
            || !char.IsAsciiLetterOrDigit(generation[0])
            || generation.Any(static character => !char.IsAsciiLetterOrDigit(character)
                && character is not '.' and not '_' and not '-'))
        {
            throw new ArgumentException("Generation must be a safe immutable identifier.", nameof(generation));
        }

        return generation;
    }

    private static string NormalizeRelativePath(string relativePath)
    {
        if (string.IsNullOrWhiteSpace(relativePath) || Path.IsPathRooted(relativePath))
        {
            throw new ArgumentException("Artifact path must be relative.", nameof(relativePath));
        }

        string normalized = relativePath.Replace('/', Path.DirectorySeparatorChar)
            .Replace('\\', Path.DirectorySeparatorChar);
        string[] segments = normalized.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0 || segments.Any(static segment => segment is "." or ".."))
        {
            throw new ArgumentException("Artifact path cannot contain traversal segments.", nameof(relativePath));
        }

        return Path.Combine(segments);
    }

    private static void EnsurePublicationPathIsNotReserved(string relativePath)
    {
        string firstSegment = relativePath.Split(Path.DirectorySeparatorChar, 2)[0];
        if (firstSegment.Equals("generations", StringComparison.OrdinalIgnoreCase)
            || firstSegment.Equals(".artifacts", StringComparison.OrdinalIgnoreCase)
            || firstSegment.Equals(".pointers", StringComparison.OrdinalIgnoreCase)
            || firstSegment.Equals(".locks", StringComparison.OrdinalIgnoreCase)
            || firstSegment.StartsWith(".staging-", StringComparison.OrdinalIgnoreCase)
            || firstSegment.StartsWith(".pointer-", StringComparison.OrdinalIgnoreCase)
            || relativePath.Equals("current.json", StringComparison.OrdinalIgnoreCase)
            || relativePath.Equals("generation-manifest.json", StringComparison.OrdinalIgnoreCase)
            || relativePath.Equals(".publication.lock", StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("Artifact path is reserved by the release-derived publication protocol.", nameof(relativePath));
        }
    }

    private static string ResolveRelativePath(string root, string relativePath)
    {
        string candidate = Path.GetFullPath(Path.Combine(root, NormalizeRelativePath(relativePath)));
        string prefix = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
        if (!candidate.StartsWith(prefix, PathComparison))
        {
            throw new InvalidOperationException("Derived artifact path escaped its generation root.");
        }

        return candidate;
    }

    private static void EnsureReleaseDerivedTarget(string releaseRoot, string candidatePath)
    {
        string normalizedReleaseRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(releaseRoot));
        string normalizedCandidate = Path.GetFullPath(candidatePath);
        string prefix = normalizedReleaseRoot + Path.DirectorySeparatorChar;
        if (!normalizedCandidate.StartsWith(prefix, PathComparison))
        {
            throw new InvalidOperationException("Publication target escaped its immutable release-derived root.");
        }
    }

    private static (TimeSpan Timeout, TimeSpan RetryDelay) NormalizeLockTiming(
        TimeSpan? timeout,
        TimeSpan? retryDelay)
    {
        TimeSpan normalizedTimeout = timeout ?? DefaultLockTimeout;
        TimeSpan normalizedRetryDelay = retryDelay ?? DefaultLockRetryDelay;
        if (normalizedTimeout <= TimeSpan.Zero || normalizedRetryDelay <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(timeout), "Publication lock timing must be positive.");
        }

        return (normalizedTimeout, normalizedRetryDelay);
    }

    private static void DeleteStagingDirectory(string stagingRoot)
    {
        if (Directory.Exists(stagingRoot))
        {
            Directory.Delete(stagingRoot, recursive: true);
        }
    }

    private static StringComparer PathComparer => OperatingSystem.IsWindows()
        ? StringComparer.OrdinalIgnoreCase
        : StringComparer.Ordinal;

    private static StringComparison PathComparison => OperatingSystem.IsWindows()
        ? StringComparison.OrdinalIgnoreCase
        : StringComparison.Ordinal;
}
