using System.Buffers;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotFileShellCache : IPublicAotShellCache
{
    private const int InvalidationBatchSize = 256;
    private readonly IConnectionMultiplexer _redis;
    private readonly IDatabase _db;
    private readonly PublicAotArtifactCommitJournal _commitJournal;
    private readonly Func<PublicAotArtifactCommitState, CancellationToken, Task>? _commitObserver;
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _commitLocks = new(StringComparer.Ordinal);
    private readonly string _cacheRoot;
    private readonly ReleaseDerivedArtifactPublisher? _derivedPublisher;
    private readonly ILogger<PublicAotFileShellCache> _logger;
    private readonly PublicAotBoundedMemoryCache _memoryCache;
    private readonly ConcurrentDictionary<string, FileMetadataCacheEntry> _fileMetadataCache = new(StringComparer.Ordinal);
    private readonly TimeProvider _timeProvider;
    private readonly IPublicArtifactStorage _publicArtifactStorage;
    private long _memoryGeneration;
    private long _distributedMemoryInvalidationGeneration;
    private PublicAotRecordedInvalidation? _lastInvalidation;

    public PublicAotFileShellCache(
        IWebHostEnvironment env,
        IConnectionMultiplexer redis,
        ILogger<PublicAotFileShellCache> logger,
        ReleaseDerivedArtifactPublisher? derivedPublisher = null,
        IConfiguration? configuration = null,
        TimeProvider? timeProvider = null,
        IPublicArtifactStorage? publicArtifactStorage = null)
        : this(
            env,
            redis,
            logger,
            derivedPublisher,
            configuration,
            timeProvider,
            publicArtifactStorage,
            commitObserver: null)
    {
    }

    internal PublicAotFileShellCache(
        IWebHostEnvironment env,
        IConnectionMultiplexer redis,
        ILogger<PublicAotFileShellCache> logger,
        ReleaseDerivedArtifactPublisher? derivedPublisher,
        IConfiguration? configuration,
        TimeProvider? timeProvider,
        IPublicArtifactStorage? publicArtifactStorage,
        Func<PublicAotArtifactCommitState, CancellationToken, Task>? commitObserver = null)
    {
        _redis = redis;
        _db = redis.GetDatabase();
        _derivedPublisher = derivedPublisher ?? ResolveReleaseDerivedPublisher();
        _cacheRoot = _derivedPublisher?.GetKindRoot("public-aot") ?? ResolveCacheRoot(env);
        _timeProvider = timeProvider ?? TimeProvider.System;
        _publicArtifactStorage = publicArtifactStorage ?? new LocalPublicArtifactStorage(env);
        _commitJournal = new PublicAotArtifactCommitJournal(_cacheRoot, _timeProvider);
        _commitObserver = commitObserver;
        var cacheOptions = new PublicAotFileShellCacheOptions();
        configuration?.GetSection("PublicAot").Bind(cacheOptions);
        _memoryCache = new PublicAotBoundedMemoryCache(
            PublicAotMemoryCacheLimits.Resolve(cacheOptions),
            _timeProvider);
        this._logger = logger;
    }

    internal PublicAotRecordedInvalidation? LastInvalidationForTests => _lastInvalidation;
    internal PublicAotMemoryCacheSnapshot MemoryCacheSnapshotForTests => _memoryCache.Snapshot();
    internal long DistributedMemoryInvalidationGenerationForTests
        => Volatile.Read(ref _distributedMemoryInvalidationGeneration);

    internal void InvalidateDistributedMemoryState()
    {
        Interlocked.Increment(ref _memoryGeneration);
        _memoryCache.Clear();
        _fileMetadataCache.Clear();
        Interlocked.Increment(ref _distributedMemoryInvalidationGeneration);
    }

    public async Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
        => await TryGetEntryAsync(cacheKey, frontendAssetVersion: null, cancellationToken).ConfigureAwait(false);

    public async Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, string? frontendAssetVersion, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetMemoryEntry(cacheKey, out var cachedValue))
        {
            return cachedValue;
        }

        return await TryReadCachedEntryAsync(cacheKey, frontendAssetVersion, cancellationToken).ConfigureAwait(false);
    }

    public async Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string targetPath = GetEntryPath(entry.CacheKey, entry.FrontendAssetVersion, entry.PageId);
        byte[] payload = SerializeEntryBytes(entry);
        string relativePath = _commitJournal.GetRelativePath(targetPath);
        string[] registryKeys = ResolveRegistryKeys(entry.CacheKey);
        PublicAotArtifactTransaction transaction = _commitJournal.Create(
            entry.CacheKey,
            relativePath,
            payload,
            registryKeys);
        SemaphoreSlim commitLock = _commitLocks.GetOrAdd(
            transaction.ArtifactId,
            static _ => new SemaphoreSlim(1, 1));
        await commitLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await using FileStream transactionLock = await _commitJournal.AcquireLockAsync(
                transaction.ArtifactId,
                cancellationToken).ConfigureAwait(false);
            await _commitJournal.PersistAsync(transaction, cancellationToken).ConfigureAwait(false);
            await _commitJournal.WriteStagingPayloadAsync(transaction, payload, cancellationToken)
                .ConfigureAwait(false);
            await ObserveCommitStateAsync(transaction.State, cancellationToken).ConfigureAwait(false);

            await CommitArtifactAsync(transaction, payload, cancellationToken).ConfigureAwait(false);
            transaction = await AdvanceAndObserveAsync(
                transaction,
                PublicAotArtifactCommitState.ArtifactCommitted,
                cancellationToken).ConfigureAwait(false);

            await RegisterTransactionAsync(transaction, cancellationToken).ConfigureAwait(false);
            transaction = await AdvanceAndObserveAsync(
                transaction,
                PublicAotArtifactCommitState.RegistryCommitted,
                cancellationToken).ConfigureAwait(false);

            await _commitJournal.WritePointerAsync(transaction, cancellationToken).ConfigureAwait(false);
            transaction = await AdvanceAndObserveAsync(
                transaction,
                PublicAotArtifactCommitState.PointerAdvanced,
                cancellationToken).ConfigureAwait(false);
            transaction = await AdvanceAndObserveAsync(
                transaction,
                PublicAotArtifactCommitState.Complete,
                cancellationToken).ConfigureAwait(false);

            _memoryCache[entry.CacheKey] = CreateMemoryCacheEntry(entry);
            UpdateFileMetadataEntry(targetPath, entry);
            File.Delete(_commitJournal.GetStagingPath(transaction.ArtifactId));
            DeleteSupersededVersions(entry.CacheKey, targetPath);
        }
        finally
        {
            commitLock.Release();
        }
    }

    public async Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long started = Stopwatch.GetTimestamp();
        PublicAotBatchInvalidationStats stats = await RemoveManyLocalAsync([cacheKey], cancellationToken).ConfigureAwait(false);
        await PublishInvalidationAsync(PublicAotInvalidationMessage.Key(cacheKey)).ConfigureAwait(false);
        RecordInvalidation("key", stats.WithPublish(), Stopwatch.GetElapsedTime(started));
    }

    public async Task RemoveManyAsync(IReadOnlyCollection<string> cacheKeys, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string[] distinctKeys = [.. cacheKeys.Where(static key => !string.IsNullOrWhiteSpace(key)).Distinct(StringComparer.Ordinal)];
        if (distinctKeys.Length == 0)
        {
            return;
        }

        long started = Stopwatch.GetTimestamp();
        PublicAotBatchInvalidationStats stats = await RemoveManyLocalAsync(distinctKeys, cancellationToken).ConfigureAwait(false);
        int publishCount = 0;
        foreach (string cacheKey in distinctKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await PublishInvalidationAsync(PublicAotInvalidationMessage.Key(cacheKey)).ConfigureAwait(false);
            publishCount++;
        }

        RecordInvalidation(
            "keys",
            new PublicAotBatchInvalidationStats(
                stats.InvalidatedKeys,
                stats.DeletedFiles,
                stats.RegistryRemovedMembers,
                publishCount),
            Stopwatch.GetElapsedTime(started));
    }

    public async Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(prefix))
        {
            return;
        }

        long started = Stopwatch.GetTimestamp();
        string registryKey = ResolveRegistryKey(prefix, out bool requiresPrefixFilter);
        PublicAotBatchInvalidationStats stats = await RemoveRegisteredKeysBatchAsync(registryKey, prefix, requiresPrefixFilter, cancellationToken).ConfigureAwait(false);
        if (stats.InvalidatedKeys == 0)
        {
            if (!string.Equals(registryKey, PublicAotCacheRegistry.GlobalRegistryKey, StringComparison.Ordinal))
            {
                stats = stats.Add(await RemoveRegisteredKeysBatchAsync(PublicAotCacheRegistry.GlobalRegistryKey, prefix, requiresPrefixFilter: true, cancellationToken).ConfigureAwait(false));
            }
        }

        string[] indexedKeys = _commitJournal.EnumerateTransactions()
            .Where(transaction => transaction.CacheKey.StartsWith(prefix, StringComparison.Ordinal))
            .Select(static transaction => transaction.CacheKey)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        stats = stats.Add(await RemoveManyLocalAsync(indexedKeys, cancellationToken).ConfigureAwait(false));
        int removedOrphans = _commitJournal.RemoveOrphansByPrefix(prefix);
        stats = stats.Add(new PublicAotBatchInvalidationStats(removedOrphans, removedOrphans, 0, 0));
        _logger.LogInformation(
            "public-aot-prefix-invalidation-checked-durable-index {Prefix} {IndexedKeyCount} {OrphanCount}",
            prefix,
            indexedKeys.Length,
            removedOrphans);

        await PublishInvalidationAsync(PublicAotInvalidationMessage.Prefix(prefix)).ConfigureAwait(false);
        RecordInvalidation("prefix", stats.WithPublish(), Stopwatch.GetElapsedTime(started));
    }

    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        long started = Stopwatch.GetTimestamp();
        Interlocked.Increment(ref _memoryGeneration);
        _memoryCache.Clear();
        _fileMetadataCache.Clear();
        int deletedFiles = 0;
        if (Directory.Exists(_cacheRoot))
        {
            foreach (string file in EnumerateEntryFiles())
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (DeleteCompatibilityEntryFile(file, cancellationToken))
                {
                    deletedFiles++;
                }
            }
        }

        PublicAotRegistryCleanupResult registryCleanup = await ClearRegistryAsync(cancellationToken).ConfigureAwait(false);

        await PublishInvalidationAsync(PublicAotInvalidationMessage.All()).ConfigureAwait(false);
        RecordInvalidation(
            "all",
            new PublicAotBatchInvalidationStats(0, deletedFiles, 0, 1).WithRegistryCleanup(registryCleanup),
            Stopwatch.GetElapsedTime(started));
    }

    private async Task<PublicAotCacheEntry?> TryReadCachedEntryAsync(
        string cacheKey,
        string? frontendAssetVersion,
        CancellationToken cancellationToken)
    {
        foreach (string path in ResolveCandidateEntryPaths(cacheKey, frontendAssetVersion))
        {
            string relativePath = _commitJournal.GetRelativePath(path);
            if (!_commitJournal.TryReadTransactionForCacheKey(
                    cacheKey,
                    out PublicAotArtifactTransaction? transaction))
            {
                if (File.Exists(path))
                {
                    await _commitJournal.QuarantineAsync(
                        cacheKey,
                        relativePath,
                        "missing-or-incomplete-transaction",
                        cancellationToken).ConfigureAwait(false);
                }

                continue;
            }

            if (transaction!.State != PublicAotArtifactCommitState.Complete)
            {
                continue;
            }

            if (!File.Exists(path))
            {
                continue;
            }

            byte[] payload = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
            if (!_commitJournal.AuthorizesRead(cacheKey, relativePath, payload))
            {
                await _commitJournal.QuarantineAsync(
                    cacheKey,
                    relativePath,
                    "pointer-or-digest-mismatch",
                    cancellationToken).ConfigureAwait(false);
                _fileMetadataCache.TryRemove(path, out _);
                continue;
            }

            PublicAotCacheEntry? entry = await TryReadEntryAsync(path, cancellationToken).ConfigureAwait(false);
            if (entry is null)
            {
                continue;
            }

            if (!string.Equals(entry.CacheKey, cacheKey, StringComparison.Ordinal))
            {
                RecordCacheRead("miss", "file", "public_aot_cache_miss", cacheKey, TimeSpan.Zero);
                continue;
            }

            if (!IsHydrationSidecarAvailable(entry))
            {
                DeleteInvalidEntryFile(path);
                RecordCacheRead("miss", "file", "public_aot_cache_sidecar_missing", cacheKey, TimeSpan.Zero);
                continue;
            }

            _memoryCache[cacheKey] = CreateMemoryCacheEntry(entry);
            if (entry.ExpiresAtUtc <= _timeProvider.GetUtcNow())
            {
                _memoryCache.TryRemove(cacheKey, out _);
                DeleteExpiredEntryFile(path);
                RecordCacheRead("stale", "file", "public_aot_cache_stale_removed", cacheKey, TimeSpan.Zero);
                return null;
            }

            RecordCacheRead("hit", "file", "public_aot_cache_file_hit", cacheKey, TimeSpan.Zero);
            FsusObservability.RecordPublicAotShellCacheFileAccess(cacheHit: true);
            return entry;
        }

        RecordCacheRead("miss", "file", "public_aot_cache_miss", cacheKey, TimeSpan.Zero);
        FsusObservability.RecordPublicAotShellCacheFileAccess(cacheHit: false);
        return null;
    }

    private bool TryGetMemoryEntry(string cacheKey, out PublicAotCacheEntry? value)
    {
        value = null;
        if (!_memoryCache.TryGetValue(cacheKey, out PublicAotMemoryCacheEntry? cached))
        {
            return false;
        }

        long generation = Volatile.Read(ref _memoryGeneration);
        if (cached.GenerationToken != generation)
        {
            _memoryCache.TryRemove(cacheKey, out _);
            return false;
        }

        value = cached.Entry;
        if (!IsHydrationSidecarAvailable(cached.Entry))
        {
            _memoryCache.TryRemove(cacheKey, out _);
            RecordCacheRead("miss", "memory", "public_aot_cache_sidecar_missing", cacheKey, TimeSpan.Zero);
            value = null;
            return false;
        }

        if (cached.ExpiresAtUtc <= _timeProvider.GetUtcNow())
        {
            _memoryCache.TryRemove(cacheKey, out _);
            DeleteExpiredEntryFile(GetEntryPath(cacheKey, cached.FrontendAssetVersion, cached.Entry.PageId));
            RecordCacheRead("stale", "memory", "public_aot_cache_stale_removed", cacheKey, TimeSpan.Zero);
            return false;
        }

        RecordCacheRead("hit", "memory", "public_aot_cache_memory_hit", cacheKey, TimeSpan.Zero);
        return true;
    }

    private async Task<PublicAotCacheEntry?> TryReadEntryAsync(string path, CancellationToken cancellationToken)
    {
        var fileInfo = new FileInfo(path);
        if (!fileInfo.Exists)
        {
            return null;
        }

        DateTime lastWriteTimeUtc = File.GetLastWriteTimeUtc(path);
        if (TryGetFileMetadataEntry(path, lastWriteTimeUtc, fileInfo.Length, out PublicAotCacheEntry? cached))
        {
            FsusObservability.RecordCacheOperation(
                "read",
                nameof(CachePolicyId.PublicAotDocument),
                "file-metadata",
                "hit",
                TimeSpan.Zero);
            return cached;
        }

        long started = Stopwatch.GetTimestamp();
        try
        {
            await using var stream = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 64 * 1024,
                options: FileOptions.Asynchronous | FileOptions.SequentialScan);
            if (stream.Length <= 0 || stream.Length > int.MaxValue)
            {
                return null;
            }

            int length = checked((int)stream.Length);
            byte[] raw = ArrayPool<byte>.Shared.Rent(length);
            try
            {
                int totalRead = 0;
                while (totalRead < length)
                {
                    int read = await stream.ReadAsync(raw.AsMemory(totalRead, length - totalRead), cancellationToken).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    totalRead += read;
                }

                if (totalRead != length)
                {
                    return null;
                }

                PublicAotCacheEntry? entry = PublicAotCacheEntryBinaryCodec.Decode(raw.AsMemory(0, totalRead));
                if (entry is not null)
                {
                    _fileMetadataCache[path] = new FileMetadataCacheEntry(lastWriteTimeUtc, length, entry, Volatile.Read(ref _memoryGeneration));
                }

                return entry;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(raw, clearArray: false);
                TimeSpan elapsed = Stopwatch.GetElapsedTime(started);
                FsusObservability.RecordCacheOperation(
                    "read",
                    nameof(CachePolicyId.PublicAotDocument),
                    "file",
                    "completed",
                    elapsed);
                _logger.LogDebug("public_aot_cache_file_read_ms {Path} {ElapsedMs}", path, elapsed.TotalMilliseconds);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            TimeSpan elapsed = Stopwatch.GetElapsedTime(started);
            FsusObservability.RecordCacheOperation(
                "read",
                nameof(CachePolicyId.PublicAotDocument),
                "file",
                "error",
                elapsed);
            _logger.LogWarning(ex, "public_aot_cache_read_error {Path}", path);
            return null;
        }
    }

    private bool IsHydrationSidecarAvailable(PublicAotCacheEntry entry)
    {
        if (!TryResolveHydrationSidecar(entry, out PublicAotHydrationSidecarReference sidecar))
        {
            return true;
        }

        PublicArtifactKey key = PublicArtifactKey.HydrationSidecar(
            entry.RouteKey,
            sidecar.Sha256Hex,
            entry.FrontendAssetVersion);
        if (!_publicArtifactStorage.IsValid(key, LocalPublicArtifactStorage.AedsMediaType, sidecar.Sha256Hex))
        {
            _logger.LogWarning(
                "public_aot_cache_sidecar_hash_mismatch {CacheKey} {RouteKey} {SidecarUrl}",
                entry.CacheKey,
                entry.RouteKey,
                sidecar.Url);
            return false;
        }

        return true;
    }

    private static bool TryResolveHydrationSidecar(
        PublicAotCacheEntry entry,
        out PublicAotHydrationSidecarReference sidecar)
    {
        if (!entry.HydrationSidecar.IsEmpty)
        {
            sidecar = entry.HydrationSidecar;
            return true;
        }

        return PublicAotHydrationSidecarReference.TryFromHtml(entry.GetHtml(), out sidecar);
    }

    private PublicAotMemoryCacheEntry CreateMemoryCacheEntry(PublicAotCacheEntry entry)
    {
        DateTimeOffset now = _timeProvider.GetUtcNow();
        DateTimeOffset cacheDeadline = now + _memoryCache.Limits.EntryDeadline;
        if (entry.ExpiresAtUtc < cacheDeadline)
        {
            cacheDeadline = entry.ExpiresAtUtc;
        }

        return new PublicAotMemoryCacheEntry(
            entry,
            entry.ExpiresAtUtc,
            entry.RendererVersion,
            entry.FrontendAssetVersion,
            Volatile.Read(ref _memoryGeneration),
            EstimateMemoryEntryBytes(entry),
            cacheDeadline);
    }

    private static long EstimateMemoryEntryBytes(PublicAotCacheEntry entry)
    {
        long strings = checked(
            ((long)(entry.CacheKey?.Length ?? 0)
             + (entry.RouteKey?.Length ?? 0)
             + (entry.RendererVersion?.Length ?? 0)
             + (entry.FrontendAssetVersion?.Length ?? 0)
             + (entry.Value?.Length ?? 0)
             + (entry.HydrationSidecar.Url?.Length ?? 0)
             + (entry.HydrationSidecar.Sha256Hex?.Length ?? 0)
             + (entry.HydrationSidecar.RelativePath?.Length ?? 0)) * sizeof(char));
        long document = entry.Document?.ResidentBytes ?? 0;
        return checked(512 + strings + document);
    }

    private bool TryGetFileMetadataEntry(
        string path,
        DateTime lastWriteTimeUtc,
        long length,
        out PublicAotCacheEntry? entry)
    {
        entry = null;
        if (!_fileMetadataCache.TryGetValue(path, out FileMetadataCacheEntry? cached))
        {
            return false;
        }

        long generation = Volatile.Read(ref _memoryGeneration);
        if (cached.GenerationToken != generation ||
            cached.LastWriteTimeUtc != lastWriteTimeUtc ||
            cached.Length != length)
        {
            _fileMetadataCache.TryRemove(path, out _);
            return false;
        }

        entry = cached.Entry;
        return true;
    }

    private void UpdateFileMetadataEntry(string path, PublicAotCacheEntry entry)
    {
        var fileInfo = new FileInfo(path);
        if (fileInfo.Exists)
        {
            _fileMetadataCache[path] = new FileMetadataCacheEntry(
                fileInfo.LastWriteTimeUtc,
                fileInfo.Length,
                entry,
                Volatile.Read(ref _memoryGeneration));
        }
    }

    private void RecordCacheRead(string result, string layer, string logToken, string cacheKey, TimeSpan duration)
    {
        FsusObservability.RecordCacheOperation(
            "lookup",
            nameof(CachePolicyId.PublicAotDocument),
            layer,
            result,
            duration);
        switch (logToken)
        {
            case "public_aot_cache_memory_hit":
                _logger.LogDebug("public_aot_cache_memory_hit {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_file_hit":
                _logger.LogDebug("public_aot_cache_file_hit {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_miss":
                _logger.LogDebug("public_aot_cache_miss {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_stale_removed":
                _logger.LogDebug("public_aot_cache_stale_removed {CacheKey}", cacheKey);
                break;
            case "public_aot_cache_sidecar_missing":
                _logger.LogDebug("public_aot_cache_sidecar_missing {CacheKey}", cacheKey);
                break;
            default:
                _logger.LogDebug("public_aot_cache_lookup {Result} {Layer} {CacheKey}", result, layer, cacheKey);
                break;
        }
    }

    private void DeleteExpiredEntryFile(string path)
        => DeleteEntryFile(path, "public_aot_cache_expired_delete_failed", LogLevel.Warning);

    private void DeleteInvalidEntryFile(string path)
        => DeleteEntryFile(path, "public_aot_cache_invalid_entry_delete_failed", LogLevel.Debug);

    private void DeleteEntryFile(string path, string failureToken, LogLevel failureLevel)
    {
        try
        {
            if (DeleteCompatibilityEntryFile(path, CancellationToken.None))
            {
                _fileMetadataCache.TryRemove(path, out _);
            }
        }
        catch (Exception ex)
        {
            _logger.Log(failureLevel, ex, "{FailureToken} {Path}", failureToken, path);
        }
    }

    private bool DeleteCompatibilityEntryFile(string path, CancellationToken cancellationToken)
    {
        if (_derivedPublisher is not null)
        {
            string relativePath = Path.GetRelativePath(_cacheRoot, path);
            return _derivedPublisher.RemoveArtifactProjectionAsync(
                    "public-aot",
                    relativePath,
                    cancellationToken)
                .GetAwaiter()
                .GetResult();
        }

        if (!File.Exists(path))
        {
            return false;
        }

        File.Delete(path);
        return true;
    }

    internal static byte[] SerializeEntryBytes(PublicAotCacheEntry entry)
        => PublicAotCacheEntryBinaryCodec.Encode(entry);

    internal static byte[] SerializeLegacyEntryBytesForTests(PublicAotCacheEntry entry)
        => PublicAotCacheEntryBinaryCodec.EncodeLegacyForTests(entry);

    internal static PublicAotCacheEntry? DeserializeEntryBytes(ReadOnlySpan<byte> payload)
        => PublicAotCacheEntryBinaryCodec.Decode(payload);

    internal static PublicAotCacheEntry? DeserializeEntryBytes(ReadOnlyMemory<byte> payload)
        => PublicAotCacheEntryBinaryCodec.Decode(payload);

    private static string ResolveWebRoot(IWebHostEnvironment env)
    {
        return string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath;
    }

    private static string ResolveCacheRoot(IWebHostEnvironment env)
        => ResolveCacheRoot(
            env,
            Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT"),
            Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID"));

    private static string ResolveCacheRoot(
        IWebHostEnvironment env,
        string? releaseDerivedRoot,
        string? releaseId)
    {
        if (!string.IsNullOrWhiteSpace(releaseDerivedRoot) || !string.IsNullOrWhiteSpace(releaseId))
        {
            if (string.IsNullOrWhiteSpace(releaseDerivedRoot) || string.IsNullOrWhiteSpace(releaseId))
            {
                throw new InvalidOperationException(
                    "Release-scoped PublicAOT storage requires both FSUSBLOG_RELEASE_DERIVED_ROOT and FSUSBLOG_RELEASE_ID.");
            }

            return ReleaseStorageLayout.BuildReleaseDerivedPath(
                releaseDerivedRoot,
                releaseId,
                "public-aot");
        }

        if (env.IsProduction())
        {
            throw new InvalidOperationException(
                "Production PublicAOT storage requires FSUSBLOG_RELEASE_DERIVED_ROOT and FSUSBLOG_RELEASE_ID.");
        }

        return Path.Combine(ResolveWebRoot(env), "aot-cache");
    }

    private static ReleaseDerivedArtifactPublisher? ResolveReleaseDerivedPublisher()
    {
        string? releaseDerivedRoot = Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        string? releaseId = Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID");
        if (string.IsNullOrWhiteSpace(releaseDerivedRoot) && string.IsNullOrWhiteSpace(releaseId))
        {
            return null;
        }

        if (string.IsNullOrWhiteSpace(releaseDerivedRoot) || string.IsNullOrWhiteSpace(releaseId))
        {
            throw new InvalidOperationException(
                "Release-scoped PublicAOT publication requires both FSUSBLOG_RELEASE_DERIVED_ROOT and FSUSBLOG_RELEASE_ID.");
        }

        return new ReleaseDerivedArtifactPublisher(releaseDerivedRoot, releaseId);
    }

    internal static string ResolveCacheRootForTests(
        IWebHostEnvironment env,
        string? releaseDerivedRoot,
        string? releaseId)
        => ResolveCacheRoot(env, releaseDerivedRoot, releaseId);

    private IEnumerable<string> EnumerateEntryFiles()
    {
        if (!Directory.Exists(_cacheRoot))
        {
            return [];
        }

        string[] retainedPublicationPrefixes =
        [
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(_cacheRoot, "generations")))
                + Path.DirectorySeparatorChar,
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(_cacheRoot, ".artifacts")))
                + Path.DirectorySeparatorChar,
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(_cacheRoot, ".orphan-artifacts")))
                + Path.DirectorySeparatorChar,
            Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.Combine(_cacheRoot, ".transaction-stage")))
                + Path.DirectorySeparatorChar
        ];
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        return Directory.EnumerateFiles(_cacheRoot, "*.aeds", SearchOption.AllDirectories)
            .Where(path => retainedPublicationPrefixes.All(prefix => !Path.GetFullPath(path).StartsWith(prefix, comparison)));
    }

    private IEnumerable<string> ResolveCandidateEntryPaths(string cacheKey, string? frontendAssetVersion)
    {
        if (!string.IsNullOrWhiteSpace(frontendAssetVersion))
        {
            yield return GetEntryPath(cacheKey, frontendAssetVersion, ResolvePageId(cacheKey));
        }

        yield return GetLegacyEntryPath(cacheKey);
    }

    private IEnumerable<string> EnumerateEntryPathsForKey(string cacheKey)
    {
        yield return GetLegacyEntryPath(cacheKey);

        string hash = ToHash(cacheKey);
        string versionedRoot = Path.Combine(_cacheRoot, "frontend");
        if (!Directory.Exists(versionedRoot))
        {
            yield break;
        }

        foreach (string path in Directory.EnumerateFiles(versionedRoot, $"{hash}.aeds", SearchOption.AllDirectories))
        {
            yield return path;
        }
    }

    private string GetEntryPath(string cacheKey, string? frontendAssetVersion, PublicPageId pageId)
        => string.IsNullOrWhiteSpace(frontendAssetVersion)
            ? GetLegacyEntryPath(cacheKey)
            : GetVersionedEntryPath(cacheKey, frontendAssetVersion, pageId);

    private string GetLegacyEntryPath(string cacheKey)
    {
        string hash = ToHash(cacheKey);
        string bucket = hash[..2];
        return Path.Combine(_cacheRoot, bucket, $"{hash}.aeds");
    }

    private string GetVersionedEntryPath(string cacheKey, string frontendAssetVersion, PublicPageId pageId)
    {
        string hash = ToHash(cacheKey);
        string bucket = hash[..2];
        return Path.Combine(
            _cacheRoot,
            "frontend",
            SanitizePathSegment(frontendAssetVersion),
            pageId.ToString(),
            bucket,
            $"{hash}.aeds");
    }

    private static PublicPageId ResolvePageId(string cacheKey)
        => PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out _)
            ? pageId
            : PublicPageId.Home;

    private void DeleteSupersededVersions(string cacheKey, string currentPath)
    {
        try
        {
            foreach (string path in EnumerateEntryPathsForKey(cacheKey))
            {
                if (string.Equals(Path.GetFullPath(path), Path.GetFullPath(currentPath), StringComparison.Ordinal))
                {
                    continue;
                }

                string relativePath = _commitJournal.GetRelativePath(path);
                if (_commitJournal.IsActiveTransactionForPath(relativePath)
                    || _commitJournal.IsPointerTarget(relativePath))
                {
                    continue;
                }

                if (DeleteCompatibilityEntryFile(path, CancellationToken.None))
                {
                    _fileMetadataCache.TryRemove(path, out _);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "public_aot_cache_superseded_version_delete_failed {CacheKey}", cacheKey);
        }
    }

    private static string SanitizePathSegment(string value)
    {
        var builder = new StringBuilder(value.Length);
        foreach (char ch in value)
        {
            builder.Append(char.IsAsciiLetterOrDigit(ch) || ch is '.' or '_' or '-' ? ch : '-');
        }

        string sanitized = builder.ToString().Trim('.', '_', '-');
        if (sanitized.Length == 0)
        {
            return "unknown";
        }

        return sanitized.Length <= 96 ? sanitized : ToHash(sanitized);
    }

    private static string ToHash(string input)
    {
        int byteCount = Encoding.UTF8.GetByteCount(input);
        Span<byte> hash = stackalloc byte[32];

        if (byteCount <= 256)
        {
            Span<byte> utf8 = stackalloc byte[byteCount];
            Encoding.UTF8.GetBytes(input.AsSpan(), utf8);
            SHA256.HashData(utf8, hash);
            return Convert.ToHexStringLower(hash);
        }

        byte[] rented = ArrayPool<byte>.Shared.Rent(byteCount);
        try
        {
            int written = Encoding.UTF8.GetBytes(input.AsSpan(), rented);
            SHA256.HashData(rented.AsSpan(0, written), hash);
            return Convert.ToHexStringLower(hash);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(rented, clearArray: true);
        }
    }

    internal static string ToHashForTests(string input) => ToHash(input);

    internal static string BuildPublicationGenerationForTests(string cacheKey, ReadOnlySpan<byte> payload)
        => BuildPublicationGeneration(cacheKey, payload);

    private static string BuildPublicationGeneration(string cacheKey, ReadOnlySpan<byte> payload)
    {
        string keyHash = ToHash(cacheKey);
        string payloadHash = Convert.ToHexStringLower(SHA256.HashData(payload));
        return $"public-aot-{keyHash[..16]}-{payloadHash}";
    }

    internal async Task RecoverArtifactTransactionsAsync(CancellationToken cancellationToken)
    {
        foreach (PublicAotArtifactTransaction candidate in _commitJournal.EnumerateTransactions())
        {
            cancellationToken.ThrowIfCancellationRequested();
            SemaphoreSlim commitLock = _commitLocks.GetOrAdd(
                candidate.ArtifactId,
                static _ => new SemaphoreSlim(1, 1));
            await commitLock.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                await using FileStream transactionLock = await _commitJournal.AcquireLockAsync(
                    candidate.ArtifactId,
                    cancellationToken).ConfigureAwait(false);
                if (!_commitJournal.TryReadTransaction(
                        candidate.ArtifactId,
                        out PublicAotArtifactTransaction? current))
                {
                    continue;
                }

                await RecoverTransactionAsync(current!, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                commitLock.Release();
            }
        }

        foreach (string path in EnumerateEntryFiles().ToArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            PublicAotCacheEntry? entry = await TryReadEntryAsync(path, cancellationToken).ConfigureAwait(false);
            if (entry is null)
            {
                continue;
            }

            string relativePath = _commitJournal.GetRelativePath(path);
            if (!_commitJournal.TryReadTransactionForCacheKey(
                    entry.CacheKey,
                    out PublicAotArtifactTransaction? transaction)
                || transaction!.State != PublicAotArtifactCommitState.Complete
                || !string.Equals(transaction.RelativePath, relativePath, StringComparison.Ordinal))
            {
                await _commitJournal.QuarantineAsync(
                    entry.CacheKey,
                    relativePath,
                    "startup-unindexed-artifact",
                    cancellationToken).ConfigureAwait(false);
                _fileMetadataCache.TryRemove(path, out _);
            }
        }
    }

    private async Task RecoverTransactionAsync(
        PublicAotArtifactTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (transaction.State == PublicAotArtifactCommitState.Complete)
        {
            string completedPath = _commitJournal.ResolveRelativePath(transaction.RelativePath);
            if (!File.Exists(completedPath))
            {
                await _commitJournal.QuarantineAsync(
                    transaction.CacheKey,
                    transaction.RelativePath,
                    "recovery-complete-artifact-missing",
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            byte[] completedPayload = await File.ReadAllBytesAsync(completedPath, cancellationToken)
                .ConfigureAwait(false);
            if (!_commitJournal.AuthorizesRead(
                    transaction.CacheKey,
                    transaction.RelativePath,
                    completedPayload))
            {
                await _commitJournal.QuarantineAsync(
                    transaction.CacheKey,
                    transaction.RelativePath,
                    "recovery-complete-transaction-mismatch",
                    cancellationToken).ConfigureAwait(false);
                await _commitJournal.AdvanceAsync(
                    transaction,
                    PublicAotArtifactCommitState.RollbackRequired,
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            File.Delete(_commitJournal.GetStagingPath(transaction.ArtifactId));
            return;
        }

        string targetPath = _commitJournal.ResolveRelativePath(transaction.RelativePath);
        if (transaction.State == PublicAotArtifactCommitState.Staged)
        {
            string stagingPath = _commitJournal.GetStagingPath(transaction.ArtifactId);
            if (!File.Exists(stagingPath))
            {
                await _commitJournal.AdvanceAsync(
                    transaction,
                    PublicAotArtifactCommitState.RollbackRequired,
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            byte[] stagingPayload = await File.ReadAllBytesAsync(stagingPath, cancellationToken).ConfigureAwait(false);
            if (!string.Equals(
                    transaction.PayloadDigest,
                    Convert.ToHexStringLower(SHA256.HashData(stagingPayload)),
                    StringComparison.Ordinal))
            {
                await _commitJournal.AdvanceAsync(
                    transaction,
                    PublicAotArtifactCommitState.RollbackRequired,
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            await CommitArtifactAsync(transaction, stagingPayload, cancellationToken).ConfigureAwait(false);
            transaction = await _commitJournal.AdvanceAsync(
                transaction,
                PublicAotArtifactCommitState.ArtifactCommitted,
                cancellationToken).ConfigureAwait(false);
        }

        if (transaction.State == PublicAotArtifactCommitState.ArtifactCommitted)
        {
            if (!await ArtifactMatchesTransactionAsync(transaction, targetPath, cancellationToken).ConfigureAwait(false))
            {
                if (File.Exists(targetPath))
                {
                    await _commitJournal.QuarantineAsync(
                        transaction.CacheKey,
                        transaction.RelativePath,
                        "recovery-artifact-digest-mismatch",
                        cancellationToken).ConfigureAwait(false);
                }

                await _commitJournal.AdvanceAsync(
                    transaction,
                    PublicAotArtifactCommitState.RollbackRequired,
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            await RegisterTransactionAsync(transaction, cancellationToken).ConfigureAwait(false);
            transaction = await _commitJournal.AdvanceAsync(
                transaction,
                PublicAotArtifactCommitState.RegistryCommitted,
                cancellationToken).ConfigureAwait(false);
        }

        if (transaction.State == PublicAotArtifactCommitState.RegistryCommitted)
        {
            await _commitJournal.WritePointerAsync(transaction, cancellationToken).ConfigureAwait(false);
            transaction = await _commitJournal.AdvanceAsync(
                transaction,
                PublicAotArtifactCommitState.PointerAdvanced,
                cancellationToken).ConfigureAwait(false);
        }

        if (transaction.State == PublicAotArtifactCommitState.PointerAdvanced)
        {
            if (!_commitJournal.PointerMatches(transaction))
            {
                await _commitJournal.WritePointerAsync(transaction, cancellationToken).ConfigureAwait(false);
            }

            transaction = await _commitJournal.AdvanceAsync(
                transaction,
                PublicAotArtifactCommitState.Complete,
                cancellationToken).ConfigureAwait(false);
            File.Delete(_commitJournal.GetStagingPath(transaction.ArtifactId));
        }
    }

    private async Task CommitArtifactAsync(
        PublicAotArtifactTransaction transaction,
        ReadOnlyMemory<byte> payload,
        CancellationToken cancellationToken)
    {
        string targetPath = _commitJournal.ResolveRelativePath(transaction.RelativePath);
        if (_derivedPublisher is not null)
        {
            string generation = BuildPublicationGeneration(transaction.CacheKey, payload.Span);
            await _derivedPublisher.PublishArtifactAndProjectAsync(
                "public-aot",
                transaction.RelativePath,
                generation,
                payload,
                cancellationToken).ConfigureAwait(false);
            return;
        }

        string directory = Path.GetDirectoryName(targetPath)!;
        Directory.CreateDirectory(directory);
        string tempPath = Path.Combine(directory, $"{Path.GetFileName(targetPath)}.{Guid.NewGuid():N}.tmp");
        try
        {
            await using (var stream = new FileStream(
                tempPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                64 * 1024,
                FileOptions.Asynchronous | FileOptions.WriteThrough))
            {
                await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
                stream.Flush(flushToDisk: true);
            }
            File.Move(tempPath, targetPath, overwrite: true);
        }
        finally
        {
            File.Delete(tempPath);
        }
    }

    private static async Task<bool> ArtifactMatchesTransactionAsync(
        PublicAotArtifactTransaction transaction,
        string path,
        CancellationToken cancellationToken)
    {
        if (!File.Exists(path))
        {
            return false;
        }

        byte[] payload = await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false);
        return string.Equals(
            transaction.PayloadDigest,
            Convert.ToHexStringLower(SHA256.HashData(payload)),
            StringComparison.Ordinal);
    }

    private async Task<PublicAotArtifactTransaction> AdvanceAndObserveAsync(
        PublicAotArtifactTransaction transaction,
        PublicAotArtifactCommitState state,
        CancellationToken cancellationToken)
    {
        PublicAotArtifactTransaction advanced = await _commitJournal.AdvanceAsync(
            transaction,
            state,
            cancellationToken).ConfigureAwait(false);
        await ObserveCommitStateAsync(state, cancellationToken).ConfigureAwait(false);
        return advanced;
    }

    private Task ObserveCommitStateAsync(
        PublicAotArtifactCommitState state,
        CancellationToken cancellationToken)
        => _commitObserver?.Invoke(state, cancellationToken) ?? Task.CompletedTask;

    private static string[] ResolveRegistryKeys(string cacheKey)
    {
        if (PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey))
        {
            return [.. PublicAotCacheRegistry.GetRegistryKeys(pageId, routeKey)];
        }

        return [PublicAotCacheRegistry.GlobalRegistryKey];
    }

    private async Task RegisterTransactionAsync(
        PublicAotArtifactTransaction transaction,
        CancellationToken cancellationToken)
    {
        foreach (string registryKey in transaction.RegistryKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _ = await _db.SetAddAsync(registryKey, transaction.CacheKey).ConfigureAwait(false);
        }
    }

    internal static string ResolveVersionedEntryPathForTests(string webRoot, string cacheKey, string frontendAssetVersion, PublicPageId pageId)
        => ResolveVersionedEntryPathInCacheRootForTests(
            Path.Combine(webRoot, "aot-cache"),
            cacheKey,
            frontendAssetVersion,
            pageId);

    internal static string ResolveVersionedEntryPathInCacheRootForTests(
        string cacheRoot,
        string cacheKey,
        string frontendAssetVersion,
        PublicPageId pageId)
    {
        string hash = ToHash(cacheKey);
        return Path.Combine(cacheRoot, "frontend", SanitizePathSegment(frontendAssetVersion), pageId.ToString(), hash[..2], $"{hash}.aeds");
    }

    internal void CollectSupersededVersionsForTests(string cacheKey, string currentPath)
        => DeleteSupersededVersions(cacheKey, currentPath);

    private async Task<PublicAotBatchInvalidationStats> RemoveRegisteredKeysBatchAsync(
        string registryKey,
        string prefix,
        bool requiresPrefixFilter,
        CancellationToken cancellationToken)
    {
        PublicAotBatchInvalidationStats stats = PublicAotBatchInvalidationStats.Empty;
        List<string> batch = new(InvalidationBatchSize);
        try
        {
            foreach (RedisValue key in _db.SetScan(registryKey, pageSize: 256))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (key.IsNullOrEmpty)
                {
                    continue;
                }

                string cacheKey = key.ToString();
                if (requiresPrefixFilter && !cacheKey.StartsWith(prefix, StringComparison.Ordinal))
                {
                    continue;
                }

                batch.Add(cacheKey);
                if (batch.Count >= InvalidationBatchSize)
                {
                    stats = stats.Add(await FlushInvalidationBatchAsync(batch, cancellationToken).ConfigureAwait(false));
                    batch.Clear();
                }
            }

            if (batch.Count > 0)
            {
                stats = stats.Add(await FlushInvalidationBatchAsync(batch, cancellationToken).ConfigureAwait(false));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex, "public-aot-read-registry-failed {RegistryKey}", registryKey);
        }

        return stats;
    }

    private async Task<PublicAotBatchInvalidationStats> FlushInvalidationBatchAsync(
        IReadOnlyCollection<string> cacheKeys,
        CancellationToken cancellationToken)
        => cacheKeys.Count == 0
            ? PublicAotBatchInvalidationStats.Empty
            : await RemoveManyLocalAsync(cacheKeys, cancellationToken).ConfigureAwait(false);

    private async Task<PublicAotBatchInvalidationStats> RemoveManyLocalAsync(
        IReadOnlyCollection<string> cacheKeys,
        CancellationToken cancellationToken)
    {
        if (cacheKeys.Count == 0)
        {
            return PublicAotBatchInvalidationStats.Empty;
        }

        string[] distinctKeys = [.. cacheKeys.Where(static key => !string.IsNullOrWhiteSpace(key)).Distinct(StringComparer.Ordinal)];
        int deletedFiles = 0;
        foreach (string cacheKey in distinctKeys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _memoryCache.TryRemove(cacheKey, out _);
            deletedFiles += DeleteEntryFilesForKey(cacheKey, cancellationToken);
        }

        long registryRemoved = await UnregisterKeysAsync(distinctKeys).ConfigureAwait(false);
        return new PublicAotBatchInvalidationStats(distinctKeys.Length, deletedFiles, registryRemoved, 0);
    }

    private int DeleteEntryFilesForKey(string cacheKey, CancellationToken cancellationToken)
    {
        int deleted = 0;
        foreach (string path in EnumerateEntryPathsForKey(cacheKey))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (DeleteCompatibilityEntryFile(path, cancellationToken))
            {
                _fileMetadataCache.TryRemove(path, out _);
                deleted++;
            }
        }

        _commitJournal.DeleteMetadata(cacheKey);
        return deleted;
    }

    private long RemoveMemoryByPrefix(string prefix, ICollection<string>? removedKeys = null)
    {
        long removed = 0;
        foreach (string cacheKey in _memoryCache.Keys)
        {
            if (cacheKey.StartsWith(prefix, StringComparison.Ordinal)
                && _memoryCache.TryRemove(cacheKey, out _))
            {
                removedKeys?.Add(cacheKey);
                removed++;
            }
        }

        return removed;
    }

    private async Task<long> UnregisterKeysAsync(IReadOnlyCollection<string> cacheKeys)
    {
        if (cacheKeys.Count == 0)
        {
            return 0;
        }

        Dictionary<string, List<RedisValue>> grouped = new(StringComparer.Ordinal);
        foreach (string cacheKey in cacheKeys)
        {
            if (PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey))
            {
                foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(pageId, routeKey))
                {
                    AddRegistryMember(grouped, registryKey, cacheKey);
                }
            }
            else
            {
                AddRegistryMember(grouped, PublicAotCacheRegistry.GlobalRegistryKey, cacheKey);
            }
        }

        long removed = 0;
        foreach ((string registryKey, List<RedisValue> members) in grouped)
        {
            await BoundaryExecutor.ExecuteAsync(
                async () => removed += await _db.SetRemoveAsync((RedisKey)registryKey, [.. members]).ConfigureAwait(false),
                _logger,
                $"public-aot-unregister-batch:{registryKey}:{members.Count}");
        }

        return removed;
    }

    private static void AddRegistryMember(Dictionary<string, List<RedisValue>> grouped, string registryKey, string cacheKey)
    {
        if (!grouped.TryGetValue(registryKey, out List<RedisValue>? members))
        {
            members = [];
            grouped[registryKey] = members;
        }

        members.Add(cacheKey);
    }

    private async Task<PublicAotRegistryCleanupResult> ClearRegistryAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey[] registryKeys = [.. PublicAotCacheRegistry.GetAllKnownRegistryKeys().Select(static key => (RedisKey)key)];
        if (registryKeys.Length == 0)
        {
            return PublicAotRegistryCleanupResult.Skipped();
        }

        try
        {
            long deletedKeys = await _db.KeyDeleteAsync(registryKeys).ConfigureAwait(false);
            return PublicAotRegistryCleanupResult.Success(deletedKeys);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "public-aot-clear-registry-failed {RegistryKeyCount}", registryKeys.Length);
            return PublicAotRegistryCleanupResult.Failed(ex.Message);
        }
    }

    private async Task UnregisterKeyAsync(string cacheKey)
    {
        _ = await UnregisterKeysAsync([cacheKey]).ConfigureAwait(false);
    }

    private static string ResolveRegistryKey(string prefix, out bool requiresPrefixFilter)
    {
        if (PublicAotCacheRegistry.TryResolveRegistryScope(prefix, out string registryKey, out requiresPrefixFilter))
        {
            return registryKey;
        }

        requiresPrefixFilter = true;
        return PublicAotCacheRegistry.GlobalRegistryKey;
    }

    internal PublicAotBatchInvalidationStats ApplyRemoteInvalidationForTests(PublicAotInvalidationMessage message)
        => ApplyRemoteInvalidation(message);

    internal PublicAotBatchInvalidationStats ApplyRemoteInvalidation(PublicAotInvalidationMessage message)
    {
        long started = Stopwatch.GetTimestamp();
        PublicAotBatchInvalidationStats stats = message.Type switch
        {
            PublicAotInvalidationMessage.TypeAll => ApplyRemoteAllInvalidation(),
            PublicAotInvalidationMessage.TypePrefix when !string.IsNullOrWhiteSpace(message.Value) => ApplyRemotePrefixInvalidation(message.Value),
            PublicAotInvalidationMessage.TypeKey when !string.IsNullOrWhiteSpace(message.Value) => ApplyRemoteKeyInvalidation(message.Value),
            _ => PublicAotBatchInvalidationStats.Empty
        };
        RecordInvalidation($"remote-{message.Type}", stats, Stopwatch.GetElapsedTime(started));
        return stats;
    }

    private PublicAotBatchInvalidationStats ApplyRemoteAllInvalidation()
    {
        Interlocked.Increment(ref _memoryGeneration);
        _memoryCache.Clear();
        _fileMetadataCache.Clear();
        int deletedFiles = 0;
        if (Directory.Exists(_cacheRoot))
        {
            foreach (string file in EnumerateEntryFiles())
            {
                if (DeleteCompatibilityEntryFile(file, CancellationToken.None))
                {
                    deletedFiles++;
                }
            }
        }

        return new PublicAotBatchInvalidationStats(0, deletedFiles, 0, 0);
    }

    private PublicAotBatchInvalidationStats ApplyRemotePrefixInvalidation(string prefix)
    {
        var removedMemoryKeys = new List<string>();
        int removedMemory = checked((int)Math.Min(int.MaxValue, RemoveMemoryByPrefix(prefix, removedMemoryKeys)));
        int deletedMemoryFiles = 0;
        foreach (string cacheKey in removedMemoryKeys)
        {
            deletedMemoryFiles += DeleteEntryFilesForKey(cacheKey, CancellationToken.None);
        }

        string registryKey = ResolveRegistryKey(prefix, out bool requiresPrefixFilter);
        PublicAotBatchInvalidationStats stats = DeleteRegisteredEntryFilesByPrefix(registryKey, prefix, requiresPrefixFilter);
        if (stats.InvalidatedKeys == 0 && !string.Equals(registryKey, PublicAotCacheRegistry.GlobalRegistryKey, StringComparison.Ordinal))
        {
            stats = stats.Add(DeleteRegisteredEntryFilesByPrefix(PublicAotCacheRegistry.GlobalRegistryKey, prefix, requiresPrefixFilter: true));
        }

        string[] indexedKeys = _commitJournal.EnumerateTransactions()
            .Where(transaction => transaction.CacheKey.StartsWith(prefix, StringComparison.Ordinal))
            .Select(static transaction => transaction.CacheKey)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        foreach (string cacheKey in indexedKeys)
        {
            _memoryCache.TryRemove(cacheKey, out _);
            deletedMemoryFiles += DeleteEntryFilesForKey(cacheKey, CancellationToken.None);
        }

        int removedOrphans = _commitJournal.RemoveOrphansByPrefix(prefix);
        _logger.LogInformation(
            "public-aot-remote-prefix-invalidation-checked-durable-index {Prefix} {IndexedKeyCount} {OrphanCount}",
            prefix,
            indexedKeys.Length,
            removedOrphans);
        stats = stats.Add(new PublicAotBatchInvalidationStats(
            indexedKeys.Length + removedOrphans,
            0,
            0,
            0));

        return new PublicAotBatchInvalidationStats(
            stats.InvalidatedKeys + removedMemory,
            stats.DeletedFiles + deletedMemoryFiles,
            0,
            0);
    }

    private PublicAotBatchInvalidationStats DeleteRegisteredEntryFilesByPrefix(
        string registryKey,
        string prefix,
        bool requiresPrefixFilter)
    {
        int invalidatedKeys = 0;
        int deletedFiles = 0;
        try
        {
            foreach (RedisValue key in _db.SetScan(registryKey, pageSize: 256))
            {
                if (key.IsNullOrEmpty)
                {
                    continue;
                }

                string cacheKey = key.ToString();
                if (requiresPrefixFilter && !cacheKey.StartsWith(prefix, StringComparison.Ordinal))
                {
                    continue;
                }

                _memoryCache.TryRemove(cacheKey, out _);
                deletedFiles += DeleteEntryFilesForKey(cacheKey, CancellationToken.None);
                invalidatedKeys++;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "public-aot-remote-prefix-registry-read-failed {RegistryKey}", registryKey);
        }

        return new PublicAotBatchInvalidationStats(invalidatedKeys, deletedFiles, 0, 0);
    }

    private PublicAotBatchInvalidationStats ApplyRemoteKeyInvalidation(string cacheKey)
    {
        _memoryCache.TryRemove(cacheKey, out _);
        int deletedFiles = DeleteEntryFilesForKey(cacheKey, CancellationToken.None);
        return new PublicAotBatchInvalidationStats(1, deletedFiles, 0, 0);
    }

    private async Task PublishInvalidationAsync(PublicAotInvalidationMessage message)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                _ = await _redis.GetSubscriber()
                    .PublishAsync(RedisChannel.Literal(PublicAotInvalidationMessage.Channel), message.ToPayload())
                    .ConfigureAwait(false);
            },
            _logger,
            $"public-aot-publish:{message.Type}:{message.Value}",
            LogLevel.Debug);
    }

    private void RecordInvalidation(string scope, PublicAotBatchInvalidationStats stats, TimeSpan elapsed)
    {
        _lastInvalidation = new PublicAotRecordedInvalidation(scope, stats, elapsed);
        FsusObservability.RecordPublicAotInvalidation(
            scopes: 1,
            stats.InvalidatedKeys,
            stats.DeletedFiles,
            stats.RegistryRemovedMembers,
            stats.PublishCount,
            elapsed,
            stats.RegistryCleanupStatus,
            stats.RegistryDeletedKeys);
    }

    private sealed record FileMetadataCacheEntry(
        DateTime LastWriteTimeUtc,
        long Length,
        PublicAotCacheEntry Entry,
        long GenerationToken);
}
