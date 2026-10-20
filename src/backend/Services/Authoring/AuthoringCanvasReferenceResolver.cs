namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Resolves private canvas references through one permission-filtered upstream facts port.
/// The resolver never persists target content or mutates canvas, article, relation, or workspace state.
/// </summary>
public sealed class AuthoringCanvasReferenceResolver(
    IAuthoringCanvasDocumentStore canvasStore,
    IAuthoringCanvasReferenceFactSource factSource,
    AuthoringCanvasReferenceProjectionCache cache,
    TimeProvider timeProvider,
    AuthoringCanvasRequestLifetime? requestLifetime = null)
{
    private readonly AuthoringCanvasRequestLifetime _requestLifetime = requestLifetime ?? new();
    private readonly AuthoringCanvasReferenceVerifier _verifier = new(canvasStore, factSource, requestLifetime);
    private readonly AuthoringCanvasReferenceResolutionKernel _kernel = new(canvasStore, factSource, timeProvider);

    public async Task<AuthoringCanvasReferenceResolutionBatch> ResolveAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        CancellationToken cancellationToken = default)
        => await ResolveCoreAsync(request, useCache: true, cancellationToken).ConfigureAwait(false);

    public async Task<AuthoringCanvasReferenceVerificationResult> VerifyAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceResolutionBatch candidate,
        CancellationToken cancellationToken = default)
        => await _verifier.VerifyAsync(request, candidate, cancellationToken).ConfigureAwait(false);

    private async Task<AuthoringCanvasReferenceResolutionBatch> ResolveCoreAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        bool useCache,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        using AuthoringCanvasRequestLifetime.Borrow authorityScope = _requestLifetime.Acquire(request.Owner, cancellationToken);
        using IDisposable databaseCancellation = _requestLifetime.BindDatabaseCancellation(authorityScope);
        cancellationToken = authorityScope.Token;
        AuthoringCanvasReferenceResolutionKernel.Prepared prepared = await _kernel.PrepareAsync(
            request, useCache, ReadCachedFact, cancellationToken).ConfigureAwait(false);
        return await _requestLifetime.PublishAsync(
            authorityScope,
            token => _kernel.CompleteAsync(request, prepared, token),
            _ => cache.PublishBatch(prepared.Cacheable, authorityScope.EnsureCurrent, authorityScope.Token)).ConfigureAwait(false);
    }

    private AuthoringCanvasReferenceFact? ReadCachedFact(AuthoringCanvasReferenceCacheKey key)
        => cache.TryGet(key, out AuthoringCanvasReferenceFact? fact) ? fact : null;

    private static AuthoringCanvasReferenceCacheKey CacheKey(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        AuthoringCanvasReferenceTarget target)
        => AuthoringCanvasReferenceResolutionKernel.CacheKey(request, coordinate, target);
}

// Domain computation has no request authority or cache publication capability.
// Public entry points retain the genuine request lifetime and own final publication.
internal sealed class AuthoringCanvasReferenceResolutionKernel(
    IAuthoringCanvasDocumentStore canvasStore,
    IAuthoringCanvasReferenceFactSource factSource,
    TimeProvider timeProvider)
{
    internal sealed record Prepared(
        long Started,
        AuthoringCanvasReferenceAuthorityCoordinate Coordinate,
        AuthoringCanvasReferenceTarget[] Targets,
        Dictionary<Guid, AuthoringCanvasReferenceFact> FactsByNode,
        List<(AuthoringCanvasReferenceCacheKey Key, AuthoringCanvasReferenceFact Fact)> Cacheable,
        int CacheHits);

    internal async Task<Prepared> PrepareAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        bool useCache,
        Func<AuthoringCanvasReferenceCacheKey, AuthoringCanvasReferenceFact?> readCachedFact,
        CancellationToken cancellationToken)
    {
        AuthoringCanvasReferenceContract.ValidateRequest(request);
        await EnsureCurrentCanvasCoordinateAsync(request, cancellationToken).ConfigureAwait(false);

        long started = timeProvider.GetTimestamp();
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = await factSource.ReadAuthorityCoordinateAsync(
            request.Owner,
            request.Permission,
            cancellationToken).ConfigureAwait(false);
        AuthoringCanvasReferenceContract.ValidateAuthorityCoordinate(coordinate);

        AuthoringCanvasReferenceTarget[] targets = request.Nodes.Select(ToTarget).ToArray();
        var factsByNode = new Dictionary<Guid, AuthoringCanvasReferenceFact>(targets.Length);
        var missing = new List<AuthoringCanvasReferenceTarget>(targets.Length);
        var cacheable = new List<(AuthoringCanvasReferenceCacheKey Key, AuthoringCanvasReferenceFact Fact)>();
        int cacheHits = 0;
        foreach (AuthoringCanvasReferenceTarget target in targets)
        {
            AuthoringCanvasReferenceCacheKey cacheKey = CacheKey(request, coordinate, target);
            AuthoringCanvasReferenceFact? cached = useCache ? readCachedFact(cacheKey) : null;
            if (cached is not null)
            {
                factsByNode.Add(target.NodeId, cached);
                cacheHits++;
            }
            else
            {
                missing.Add(target);
            }
        }

        if (missing.Count > 0)
        {
            IReadOnlyList<AuthoringCanvasReferenceFact> loaded = await factSource.ReadBatchAsync(
                new AuthoringCanvasReferenceFactQuery(
                    request.CanvasId,
                    request.CanvasRevision,
                    request.CanvasContentDigest,
                    request.Owner,
                    request.Permission,
                    coordinate,
                    missing),
                cancellationToken).ConfigureAwait(false);
            var requested = missing.ToDictionary(static target => target.NodeId);
            foreach (AuthoringCanvasReferenceFact fact in loaded)
            {
                if (!requested.TryGetValue(fact.NodeId, out AuthoringCanvasReferenceTarget? target)
                    || factsByNode.ContainsKey(fact.NodeId))
                {
                    throw new AuthoringCanvasValidationException("canvas_reference_fact_set_invalid");
                }
                AuthoringCanvasReferenceContract.ValidateFact(target, fact);
                factsByNode.Add(fact.NodeId, fact);
                if (useCache)
                {
                    cacheable.Add((CacheKey(request, coordinate, target), fact));
                }
            }
        }

        return new Prepared(started, coordinate, targets, factsByNode, cacheable, cacheHits);
    }

    internal async Task<AuthoringCanvasReferenceResolutionBatch> CompleteAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        Prepared prepared,
        CancellationToken cancellationToken)
    {
        long started = prepared.Started;
        AuthoringCanvasReferenceAuthorityCoordinate coordinate = prepared.Coordinate;
        AuthoringCanvasReferenceTarget[] targets = prepared.Targets;
        Dictionary<Guid, AuthoringCanvasReferenceFact> factsByNode = prepared.FactsByNode;
        int cacheHits = prepared.CacheHits;
        // Reject a result that lost the document race before it can enter cache or reach a consumer.
        await EnsureCurrentCanvasCoordinateAsync(request, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        // Cache hits bypass batch revalidation, so recheck authority before any fact is exposed or cached.
        AuthoringCanvasReferenceAuthorityCoordinate verifiedCoordinate = await factSource.ReadAuthorityCoordinateAsync(
            request.Owner,
            request.Permission,
            cancellationToken).ConfigureAwait(false);
        AuthoringCanvasReferenceContract.ValidateAuthorityCoordinate(verifiedCoordinate);
        cancellationToken.ThrowIfCancellationRequested();
        if (verifiedCoordinate != coordinate)
        {
            throw new AuthoringCanvasValidationException("canvas_reference_authority_changed");
        }
        // The authority read is asynchronous too; keep the final document check after it.
        await EnsureCurrentCanvasCoordinateAsync(request, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        var projections = new List<AuthoringCanvasReferenceProjection>(targets.Length);
        foreach (AuthoringCanvasReferenceTarget target in targets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!factsByNode.TryGetValue(target.NodeId, out AuthoringCanvasReferenceFact? fact))
            {
                fact = DeniedOrUnknown(target);
            }
            projections.Add(Project(target, fact, request.TargetWorkspaceGroupId));
        }

        string batchDigest = AuthoringCanvasReferenceContract.ComputeBatchDigest(request, coordinate, projections);
        AuthoringCanvasReferenceResolutionReceiptItem[] receiptItems = projections.Select(static projection =>
            new AuthoringCanvasReferenceResolutionReceiptItem(
                projection.NodeId,
                projection.TargetArticleId,
                projection.TargetHeadingIdentity,
                projection.TargetBlockIdentity,
                projection.TargetRevision,
                projection.Status,
                projection.Title,
                projection.ContextSnippet,
                projection.OpenIntent,
                projection.ContentDigest)).ToArray();
        long elapsedMilliseconds = Math.Max(
            0,
            (long)timeProvider.GetElapsedTime(started).TotalMilliseconds);
        string receiptDigest = AuthoringCanvasReferenceContract.ComputeReceiptDigest(
            request,
            coordinate,
            receiptItems,
            batchDigest,
            projections.Count,
            cacheHits,
            elapsedMilliseconds);
        var receipt = new AuthoringCanvasReferenceResolutionReceipt(
            request.RequestId,
            request.CanvasId,
            request.CanvasRevision,
            request.CanvasContentDigest,
            request.Permission,
            coordinate.PermissionFingerprint,
            coordinate.Generation,
            coordinate.ContentDigest,
            projections.Count,
            cacheHits,
            elapsedMilliseconds,
            receiptItems,
            receiptDigest);
        return new AuthoringCanvasReferenceResolutionBatch(
            request.CanvasId,
            request.CanvasRevision,
            request.CanvasContentDigest,
            coordinate,
            projections,
            batchDigest,
            receipt);
    }

    private static AuthoringCanvasReferenceTarget ToTarget(AuthoringCanvasNode node)
        => new(
            node.Id,
            node.Type,
            node.TargetArticleId!.Value,
            node.TargetHeadingIdentity,
            node.TargetBlockIdentity,
            node.PinnedTargetRevision,
            node.DisplayProjectionReference);

    private static AuthoringCanvasReferenceProjection Project(
        AuthoringCanvasReferenceTarget target,
        AuthoringCanvasReferenceFact fact,
        string? targetWorkspaceGroupId)
    {
        AuthoringCanvasReferenceProjectionStatus status = Status(target, fact);
        bool contentVisible = status is AuthoringCanvasReferenceProjectionStatus.Current
            or AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
            or AuthoringCanvasReferenceProjectionStatus.PinnedStale
            or AuthoringCanvasReferenceProjectionStatus.TargetUpdated
            or AuthoringCanvasReferenceProjectionStatus.SourceStale;
        bool openEligible = contentVisible && fact.StableRoute is not null && fact.ResolvedRevision > 0;
        var projection = new AuthoringCanvasReferenceProjection(
            target.NodeId,
            target.NodeType,
            target.TargetArticleId,
            target.TargetHeadingIdentity,
            target.TargetBlockIdentity,
            status,
            contentVisible ? fact.Title : null,
            contentVisible ? fact.ContextSnippet : null,
            fact.ResolvedRevision > 0 ? fact.ResolvedRevision : null,
            fact.CurrentRevision > 0 ? fact.CurrentRevision : null,
            openEligible
                ? new AuthoringCanvasOpenIntent(
                    target.TargetArticleId,
                    fact.ResolvedRevision,
                    target.TargetHeadingIdentity,
                    target.TargetBlockIdentity,
                    fact.StableRoute!,
                    TargetGroupId: targetWorkspaceGroupId)
                : null,
            status is AuthoringCanvasReferenceProjectionStatus.PinnedStale
                or AuthoringCanvasReferenceProjectionStatus.TargetUpdated,
            string.Empty);
        projection = projection with
        {
            DisplayProjectionReference = contentVisible ? fact.DisplayProjectionReference : null
        };
        return projection with
        {
            ContentDigest = AuthoringCanvasReferenceContract.ComputeProjectionDigest(projection)
        };
    }

    private static AuthoringCanvasReferenceProjectionStatus Status(
        AuthoringCanvasReferenceTarget target,
        AuthoringCanvasReferenceFact fact)
    {
        AuthoringCanvasReferenceProjectionStatus? articleStatus = fact.ArticleState switch
        {
            AuthoringCanvasArticleState.Current => null,
            AuthoringCanvasArticleState.Missing => AuthoringCanvasReferenceProjectionStatus.Missing,
            AuthoringCanvasArticleState.Deleted => AuthoringCanvasReferenceProjectionStatus.Deleted,
            AuthoringCanvasArticleState.Archived => AuthoringCanvasReferenceProjectionStatus.Archived,
            AuthoringCanvasArticleState.PermissionDeniedOrUnknown =>
                AuthoringCanvasReferenceProjectionStatus.PermissionDeniedOrUnknown,
            _ => throw new AuthoringCanvasValidationException("canvas_reference_article_state_invalid")
        };
        if (articleStatus is not null)
        {
            return articleStatus.Value;
        }

        AuthoringCanvasReferenceProjectionStatus? coordinateStatus = fact.CoordinateState switch
        {
            AuthoringCanvasReferenceCoordinateState.Current => null,
            AuthoringCanvasReferenceCoordinateState.SourceStale =>
                AuthoringCanvasReferenceProjectionStatus.SourceStale,
            AuthoringCanvasReferenceCoordinateState.Missing => target.NodeType switch
            {
                AuthoringCanvasNodeType.HeadingReference => AuthoringCanvasReferenceProjectionStatus.HeadingMissing,
                AuthoringCanvasNodeType.BlockReference => AuthoringCanvasReferenceProjectionStatus.BlockMissing,
                _ => AuthoringCanvasReferenceProjectionStatus.Missing
            },
            AuthoringCanvasReferenceCoordinateState.Duplicate => target.NodeType switch
            {
                AuthoringCanvasNodeType.HeadingReference => AuthoringCanvasReferenceProjectionStatus.HeadingDuplicate,
                AuthoringCanvasNodeType.BlockReference => AuthoringCanvasReferenceProjectionStatus.BlockDuplicate,
                _ => AuthoringCanvasReferenceProjectionStatus.Missing
            },
            AuthoringCanvasReferenceCoordinateState.Invalid => target.NodeType switch
            {
                AuthoringCanvasNodeType.HeadingReference => AuthoringCanvasReferenceProjectionStatus.HeadingInvalid,
                AuthoringCanvasNodeType.BlockReference => AuthoringCanvasReferenceProjectionStatus.BlockInvalid,
                _ => AuthoringCanvasReferenceProjectionStatus.Missing
            },
            _ => throw new AuthoringCanvasValidationException("canvas_reference_coordinate_state_invalid")
        };
        if (coordinateStatus is not null)
        {
            return coordinateStatus.Value;
        }
        if (target.PinnedTargetRevision is not null)
        {
            return fact.CurrentRevision == target.PinnedTargetRevision.Value
                ? AuthoringCanvasReferenceProjectionStatus.PinnedCurrent
                : AuthoringCanvasReferenceProjectionStatus.PinnedStale;
        }
        return fact.TargetChangedSinceProjection
            ? AuthoringCanvasReferenceProjectionStatus.TargetUpdated
            : AuthoringCanvasReferenceProjectionStatus.Current;
    }

    private static AuthoringCanvasReferenceFact DeniedOrUnknown(AuthoringCanvasReferenceTarget target)
        => new(
            target.NodeId,
            target.TargetArticleId,
            AuthoringCanvasArticleState.PermissionDeniedOrUnknown,
            AuthoringCanvasReferenceCoordinateState.Current,
            0,
            0,
            false,
            null,
            null,
            null);

    internal static AuthoringCanvasReferenceCacheKey CacheKey(
        AuthoringCanvasReferenceResolutionRequest request,
        AuthoringCanvasReferenceAuthorityCoordinate coordinate,
        AuthoringCanvasReferenceTarget target)
        => new(
            request.CanvasId,
            request.CanvasRevision,
            request.CanvasContentDigest,
            request.Owner.AdminPrincipalId,
            request.Owner.SiteScope,
            (int)request.Permission,
            coordinate.PermissionFingerprint,
            coordinate.Generation,
            coordinate.ContentDigest,
            target.NodeId,
            AuthoringCanvasReferenceContract.ComputeTargetDigest(target));

    private async Task EnsureCurrentCanvasCoordinateAsync(
        AuthoringCanvasReferenceResolutionRequest request,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        AuthoringCanvasDocumentHeader header = await canvasStore.GetAsync(
            request.Owner,
            request.CanvasId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new AuthoringCanvasAccessDeniedException();
        if (header.Revision != request.CanvasRevision)
        {
            throw new AuthoringCanvasRevisionConflictException(request.CanvasRevision, header.Revision);
        }
        if (!string.Equals(header.ContentDigest, request.CanvasContentDigest, StringComparison.Ordinal))
        {
            throw new AuthoringCanvasValidationException("canvas_reference_content_digest_stale");
        }
    }
}

public sealed class AuthoringCanvasReferenceProjectionCache
{
    private readonly int _capacity;
    private readonly object _gate = new();
    private readonly Dictionary<AuthoringCanvasReferenceCacheKey, LinkedListNode<CacheEntry>> _entries = [];
    private readonly LinkedList<CacheEntry> _recency = [];

    public AuthoringCanvasReferenceProjectionCache(int capacity = AuthoringCanvasReferenceContract.DefaultCacheCapacity)
    {
        if (capacity <= 0 || capacity > AuthoringCanvasReferenceContract.MaxBatchSize)
        {
            throw new ArgumentOutOfRangeException(nameof(capacity));
        }
        _capacity = capacity;
    }

    public int EntryCount
    {
        get
        {
            lock (_gate)
            {
                return _entries.Count;
            }
        }
    }

    internal bool TryGet(
        AuthoringCanvasReferenceCacheKey key,
        out AuthoringCanvasReferenceFact? fact)
    {
        lock (_gate)
        {
            if (!_entries.TryGetValue(key, out LinkedListNode<CacheEntry>? node))
            {
                fact = null;
                return false;
            }
            _recency.Remove(node);
            _recency.AddLast(node);
            fact = node.Value.Fact;
            return true;
        }
    }

    internal void Set(AuthoringCanvasReferenceCacheKey key, AuthoringCanvasReferenceFact fact)
    {
        lock (_gate)
        {
            if (_entries.TryGetValue(key, out LinkedListNode<CacheEntry>? existing))
            {
                existing.Value = new CacheEntry(key, fact);
                _recency.Remove(existing);
                _recency.AddLast(existing);
                return;
            }

            var node = new LinkedListNode<CacheEntry>(new CacheEntry(key, fact));
            _recency.AddLast(node);
            _entries.Add(key, node);
            while (_entries.Count > _capacity)
            {
                LinkedListNode<CacheEntry> oldest = _recency.First!;
                _recency.RemoveFirst();
                _entries.Remove(oldest.Value.Key);
            }
        }
    }

    internal void PublishBatch(
        IReadOnlyList<(AuthoringCanvasReferenceCacheKey Key, AuthoringCanvasReferenceFact Fact)> entries,
        Action ensureCurrent,
        CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ensureCurrent();
            CacheEntry[] before = _recency.ToArray();
            try
            {
                foreach ((AuthoringCanvasReferenceCacheKey key, AuthoringCanvasReferenceFact fact) in entries)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    Set(key, fact);
                }
                ensureCurrent();
            }
            catch
            {
                _entries.Clear();
                _recency.Clear();
                foreach (CacheEntry entry in before)
                {
                    Set(entry.Key, entry.Fact);
                }
                throw;
            }
        }
    }

    private sealed record CacheEntry(
        AuthoringCanvasReferenceCacheKey Key,
        AuthoringCanvasReferenceFact Fact);
}

internal readonly record struct AuthoringCanvasReferenceCacheKey(
    Guid CanvasId,
    long CanvasRevision,
    string CanvasContentDigest,
    long AdminPrincipalId,
    string SiteScope,
    int Permission,
    string PermissionFingerprint,
    long AuthorityGeneration,
    string AuthorityContentDigest,
    Guid NodeId,
    string TargetDigest);
