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
    {
        if (authority is null)
        {
            _authority = new InMemoryPublicAotInvalidationGenerationAuthority();
            _localGenerationMirror = PublicAotInvalidationGenerationStateCodec.CreateEmpty("test");
            return;
        }

        _authority = authority;
        if (authority is InMemoryPublicAotInvalidationGenerationAuthority inMemory)
        {
            _localGenerationMirror = inMemory.Current;
        }
    }

    public Task InitializeAsync(CancellationToken cancellationToken)
        => LoadAndUpdateAsync(cancellationToken);

    public Task<long> MarkAllAsync(
        string? mutationId = null,
        CancellationToken cancellationToken = default)
        => MarkAsync("all", AllKey, mutationId, cancellationToken);

    public Task<long> MarkSitemapAsync(
        string? mutationId = null,
        CancellationToken cancellationToken = default)
        => MarkAsync(
            "key",
            PublicAotInvalidationGenerationStateCodec.SitemapCoordinate,
            mutationId,
            cancellationToken);

    public Task<long> MarkPrefixAsync(
        string prefix,
        string? mutationId = null,
        CancellationToken cancellationToken = default)
        => string.IsNullOrWhiteSpace(prefix)
            ? Task.FromResult(CurrentVersion)
            : MarkAsync("prefix", prefix, mutationId, cancellationToken);

    public Task<long> MarkKeyAsync(
        string cacheKey,
        string? mutationId = null,
        CancellationToken cancellationToken = default)
        => string.IsNullOrWhiteSpace(cacheKey)
            ? Task.FromResult(CurrentVersion)
            : MarkAsync("key", cacheKey, mutationId, cancellationToken);

    public long GetCurrentVersion(string cacheKey, string pagePrefixKey)
    {
        return LoadState().Current(cacheKey, pagePrefixKey);
    }

    public long GetLocalGeneration()
    {
        PublicAotInvalidationGenerationState? local = Volatile.Read(ref _localGenerationMirror);
        return (local ?? LoadState()).AllGeneration;
    }

    public long GetSitemapGeneration()
    {
        PublicAotInvalidationGenerationState state = Volatile.Read(ref _localGenerationMirror) ?? LoadState();
        return Math.Max(
            state.KeyGenerations.GetValueOrDefault(AllKey),
            state.KeyGenerations.GetValueOrDefault(PublicAotInvalidationGenerationStateCodec.SitemapCoordinate));
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

    private async Task<long> MarkAsync(
        string kind,
        string key,
        string? mutationId,
        CancellationToken cancellationToken)
    {
        PublicAotInvalidationGenerationState state = await _authority
            .MarkAsync(kind, key, mutationId, cancellationToken)
            .ConfigureAwait(false);
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
        PublicAotInvalidationGenerationState state = Volatile.Read(ref _localGenerationMirror)
            ?? throw new InvalidOperationException(
                "public-aot-invalidation-generation-not-initialized");
        PublicAotInvalidationGenerationStateCodec.Validate(state);
        return state;
    }

    private async Task LoadAndUpdateAsync(CancellationToken cancellationToken)
    {
        PublicAotInvalidationGenerationState durable = await _authority
            .LoadAsync(cancellationToken)
            .ConfigureAwait(false);
        PublicAotInvalidationGenerationStateCodec.Validate(durable);
        UpdateLocalMirror(durable);
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
