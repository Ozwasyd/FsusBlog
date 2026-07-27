using System.Collections.Concurrent;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationTracker
{
    private const string AllKey = "__all__";
    private readonly IPublicAotInvalidationGenerationAuthority _authority;
    private readonly ConcurrentDictionary<string, PublicAotBackfillCommitReceipt> _commitReceipts = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _publicationLocks = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _globalPublicationGate = new(1, 1);
    private PublicAotInvalidationGenerationState? _localGenerationMirror;
    private DateTimeOffset? _lastInvalidatedAt;

    public PublicAotInvalidationTracker(IPublicAotInvalidationGenerationAuthority? authority = null)
        => _authority = authority ?? new InMemoryPublicAotInvalidationGenerationAuthority();

    public long MarkAll(string? mutationId = null)
        => Mark("all", AllKey, mutationId);

    public long MarkPrefix(string prefix, string? mutationId = null)
        => string.IsNullOrWhiteSpace(prefix)
            ? CurrentVersion
            : Mark("prefix", prefix, mutationId);

    public long MarkKey(string cacheKey, string? mutationId = null)
        => string.IsNullOrWhiteSpace(cacheKey)
            ? CurrentVersion
            : Mark("key", cacheKey, mutationId);

    public long GetCurrentVersion(string cacheKey, string pagePrefixKey)
    {
        return LoadState().Current(cacheKey, pagePrefixKey);
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

    private long CurrentVersion => LoadState().AllGeneration;

    private long Mark(string kind, string key, string? mutationId)
    {
        PublicAotInvalidationGenerationState state =
            _authority.Mark(kind, key, mutationId);
        UpdateLocalMirror(state);
        _lastInvalidatedAt = DateTimeOffset.UtcNow;
        return state.AllGeneration;
    }

    private SemaphoreSlim GetPublicationLock(string pagePrefixKey)
        => _publicationLocks.GetOrAdd(
            string.IsNullOrWhiteSpace(pagePrefixKey) ? AllKey : pagePrefixKey,
            static _ => new SemaphoreSlim(1, 1));

    private static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character));

    public PublicAotInvalidationRuntimeSnapshot Snapshot()
    {
        PublicAotInvalidationGenerationState state = LoadState();
        return new(state.AllGeneration, state.KeyGenerations.Count + state.PrefixGenerations.Count, _lastInvalidatedAt ?? state.UpdatedAt);
    }

    private PublicAotInvalidationGenerationState LoadState()
    {
        for (int attempt = 0; attempt < 4; attempt++)
        {
            PublicAotInvalidationGenerationState durable = _authority.Load();
            PublicAotInvalidationGenerationStateCodec.Validate(durable);
            PublicAotInvalidationGenerationState? local =
                Volatile.Read(ref _localGenerationMirror);
            if (local is not null)
            {
                if (!string.Equals(
                    local.RuntimeScope,
                    durable.RuntimeScope,
                    StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        "public-aot-invalidation-generation-durable-regression");
                }

                if (local.AllGeneration > durable.AllGeneration)
                {
                    continue;
                }
            }

            UpdateLocalMirror(durable);
            return durable;
        }

        throw new InvalidOperationException(
            "public-aot-invalidation-generation-durable-regression");
    }

    private void UpdateLocalMirror(PublicAotInvalidationGenerationState durable)
    {
        while (true)
        {
            PublicAotInvalidationGenerationState? local =
                Volatile.Read(ref _localGenerationMirror);
            if (local is not null)
            {
                if (!string.Equals(
                    local.RuntimeScope,
                    durable.RuntimeScope,
                    StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        "public-aot-invalidation-generation-durable-regression");
                }

                if (local.AllGeneration > durable.AllGeneration)
                {
                    return;
                }
            }

            if (ReferenceEquals(
                Interlocked.CompareExchange(
                    ref _localGenerationMirror,
                    durable,
                    local),
                local))
            {
                return;
            }
        }
    }
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
