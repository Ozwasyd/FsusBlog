using System.Collections.Concurrent;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationTracker
{
    private const string AllKey = "__all__";
    private readonly ConcurrentDictionary<string, long> _versions = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PublicAotBackfillCommitReceipt> _commitReceipts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _publicationLocks = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _globalPublicationGate = new(1, 1);
    private long _nextVersion;
    private DateTimeOffset? _lastInvalidatedAt;

    public long MarkAll()
        => Mark(AllKey);

    public long MarkPrefix(string prefix)
        => string.IsNullOrWhiteSpace(prefix) ? CurrentVersion : Mark(prefix);

    public long MarkKey(string cacheKey)
        => string.IsNullOrWhiteSpace(cacheKey) ? CurrentVersion : Mark(cacheKey);

    public long GetCurrentVersion(string cacheKey, string pagePrefixKey)
    {
        long version = GetVersion(AllKey);
        version = Math.Max(version, GetVersion(cacheKey));
        version = Math.Max(version, GetVersion(pagePrefixKey));
        return version;
    }

    public bool WasInvalidatedAfter(PublicAotBackfillRequest request)
        => GetCurrentVersion(
                string.IsNullOrWhiteSpace(request.InvalidationKey) ? request.CacheKey : request.InvalidationKey,
                request.PagePrefixKey)
            > request.ScheduledInvalidationVersion;

    public long GetCurrentVersion(PublicAotBackfillRequest request)
        => GetCurrentVersion(
            string.IsNullOrWhiteSpace(request.InvalidationKey) ? request.CacheKey : request.InvalidationKey,
            request.PagePrefixKey);

    public void RecordCommitReceipt(PublicAotBackfillCommitReceipt receipt)
    {
        ArgumentNullException.ThrowIfNull(receipt);
        if (string.IsNullOrWhiteSpace(receipt.CacheKey)
            || string.IsNullOrWhiteSpace(receipt.PagePrefixKey)
            || receipt.ScheduledInvalidationVersion != receipt.CurrentInvalidationVersion
            || receipt.CurrentInvalidationVersion != receipt.PublishedInvalidationVersion
            || !IsSha256(receipt.PayloadDigest)
            || !IsSha256(receipt.ArtifactDigest)
            || !IsSha256(receipt.HotReadDigest))
        {
            throw new InvalidOperationException("public-aot-commit-receipt-invalid");
        }

        _commitReceipts[receipt.CacheKey] = receipt;
    }

    internal bool TryGetCommitReceipt(string cacheKey, out PublicAotBackfillCommitReceipt? receipt)
        => _commitReceipts.TryGetValue(cacheKey, out receipt);

    public async Task<T> WithPublicationLockAsync<T>(
        string pagePrefixKey,
        Func<Task<T>> operation,
        CancellationToken cancellationToken)
    {
        await _globalPublicationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        SemaphoreSlim publicationLock = GetPublicationLock(pagePrefixKey);
        try
        {
            await publicationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _globalPublicationGate.Release();
        }

        try
        {
            return await operation().ConfigureAwait(false);
        }
        finally
        {
            publicationLock.Release();
        }
    }

    public async Task WithInvalidationLockAsync(
        IEnumerable<string> pagePrefixKeys,
        Func<Task> operation,
        CancellationToken cancellationToken)
    {
        await _globalPublicationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        SemaphoreSlim[] publicationLocks = [.. pagePrefixKeys
            .Where(static key => !string.IsNullOrWhiteSpace(key))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static key => key, StringComparer.Ordinal)
            .Select(GetPublicationLock)];
        int acquired = 0;
        try
        {
            foreach (SemaphoreSlim publicationLock in publicationLocks)
            {
                await publicationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
                acquired++;
            }
        }
        catch
        {
            for (int index = acquired - 1; index >= 0; index--)
            {
                publicationLocks[index].Release();
            }
            throw;
        }
        finally
        {
            _globalPublicationGate.Release();
        }

        try
        {
            await operation().ConfigureAwait(false);
        }
        finally
        {
            foreach (SemaphoreSlim publicationLock in publicationLocks.Reverse())
            {
                publicationLock.Release();
            }
        }
    }

    public async Task WithGlobalInvalidationLockAsync(
        Func<Task> operation,
        CancellationToken cancellationToken)
    {
        await _globalPublicationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        SemaphoreSlim[] publicationLocks = [.. _publicationLocks
            .OrderBy(static pair => pair.Key, StringComparer.Ordinal)
            .Select(static pair => pair.Value)];
        int acquired = 0;
        try
        {
            foreach (SemaphoreSlim publicationLock in publicationLocks)
            {
                await publicationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
                acquired++;
            }
            await operation().ConfigureAwait(false);
        }
        finally
        {
            for (int index = acquired - 1; index >= 0; index--)
            {
                publicationLocks[index].Release();
            }
            _globalPublicationGate.Release();
        }
    }

    private long CurrentVersion => Interlocked.Read(ref _nextVersion);

    private long Mark(string key)
    {
        long version = Interlocked.Increment(ref _nextVersion);
        _versions.AddOrUpdate(key, version, (_, _) => version);
        _lastInvalidatedAt = DateTimeOffset.UtcNow;
        return version;
    }

    private long GetVersion(string key)
        => string.IsNullOrWhiteSpace(key) ? 0 : _versions.GetValueOrDefault(key);

    private SemaphoreSlim GetPublicationLock(string pagePrefixKey)
        => _publicationLocks.GetOrAdd(
            string.IsNullOrWhiteSpace(pagePrefixKey) ? AllKey : pagePrefixKey,
            static _ => new SemaphoreSlim(1, 1));

    private static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character));

    public PublicAotInvalidationRuntimeSnapshot Snapshot()
        => new(CurrentVersion, _versions.Count, _lastInvalidatedAt);
}

public sealed record PublicAotInvalidationRuntimeSnapshot(
    long CurrentVersion,
    int TrackedInvalidationKeys,
    DateTimeOffset? LastInvalidatedAt);

public sealed record PublicAotBackfillCommitReceipt(
    string CacheKey,
    string PagePrefixKey,
    long ScheduledInvalidationVersion,
    long CurrentInvalidationVersion,
    long PublishedInvalidationVersion,
    string FrontendAssetVersion,
    string RendererVersion,
    string PayloadDigest,
    string ArtifactDigest,
    string HotReadDigest);
