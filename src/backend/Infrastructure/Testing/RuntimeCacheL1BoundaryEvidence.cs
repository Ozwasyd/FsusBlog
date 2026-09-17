using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.Testing;

internal readonly record struct RuntimeCacheL1BoundaryEvidence(
    string RequestId,
    CachePolicyId PolicyId,
    CacheL1Operation Operation,
    bool Sampled,
    string Outcome,
    int StartedThreadId,
    int CompletedThreadId,
    long AllocatedBytes);

internal readonly struct RuntimeCacheL1BoundaryEvidenceScope
{
    private readonly string? _requestId;
    private readonly CachePolicyId _policyId;
    private readonly CacheL1Operation _operation;
    private readonly int _threadId;
    private readonly long _allocatedBytesAtStart;
    private readonly long _allocatedBytesBeforePause;
    private readonly bool _active;

    private RuntimeCacheL1BoundaryEvidenceScope(
        string requestId,
        CachePolicyId policyId,
        CacheL1Operation operation,
        int threadId,
        long allocatedBytesAtStart,
        long allocatedBytesBeforePause,
        bool active)
    {
        _requestId = requestId;
        _policyId = policyId;
        _operation = operation;
        _threadId = threadId;
        _allocatedBytesAtStart = allocatedBytesAtStart;
        _allocatedBytesBeforePause = allocatedBytesBeforePause;
        _active = active;
    }

    internal static RuntimeCacheL1BoundaryEvidenceScope Begin(
        CachePolicyId policyId,
        CacheL1Operation operation)
    {
        RuntimeCacheEvidenceObservation? request = RuntimeCacheEvidenceObservation.Current;
        return request is null
            ? default
            : new RuntimeCacheL1BoundaryEvidenceScope(
                request.RequestId,
                policyId,
                operation,
                Environment.CurrentManagedThreadId,
                GC.GetAllocatedBytesForCurrentThread(),
                0,
                active: true);
    }

    internal RuntimeCacheL1BoundaryEvidenceScope Pause()
    {
        if (_requestId is null || !_active)
        {
            return this;
        }
        int completedThreadId = Environment.CurrentManagedThreadId;
        long allocatedBytes = completedThreadId == _threadId
            ? Math.Max(0, GC.GetAllocatedBytesForCurrentThread() - _allocatedBytesAtStart)
            : -1;
        return new RuntimeCacheL1BoundaryEvidenceScope(
            _requestId,
            _policyId,
            _operation,
            _threadId,
            0,
            allocatedBytes,
            active: false);
    }

    internal RuntimeCacheL1BoundaryEvidenceScope Resume()
    {
        if (_requestId is null || _active)
        {
            return this;
        }
        long accumulated = Environment.CurrentManagedThreadId == _threadId
            ? _allocatedBytesBeforePause
            : -1;
        return new RuntimeCacheL1BoundaryEvidenceScope(
            _requestId,
            _policyId,
            _operation,
            _threadId,
            GC.GetAllocatedBytesForCurrentThread(),
            accumulated,
            active: true);
    }

    internal RuntimeCacheL1BoundaryEvidence Complete(bool sampled, string outcome)
    {
        if (_requestId is null)
        {
            return default;
        }

        long allocatedBytesAtEnd = GC.GetAllocatedBytesForCurrentThread();
        int completedThreadId = Environment.CurrentManagedThreadId;
        long finalSegment = _active
            ? Math.Max(0, allocatedBytesAtEnd - _allocatedBytesAtStart)
            : 0;
        long allocatedBytes = completedThreadId == _threadId && _allocatedBytesBeforePause >= 0
            ? _allocatedBytesBeforePause + finalSegment
            : -1;
        var evidence = new RuntimeCacheL1BoundaryEvidence(
            _requestId,
            _policyId,
            _operation,
            sampled,
            outcome,
            _threadId,
            completedThreadId,
            allocatedBytes);
        RuntimeCacheL1BoundaryEvidenceStore.Record(evidence);
        return evidence;
    }
}

internal static class RuntimeCacheL1BoundaryEvidenceStore
{
    private const int Capacity = 8192;
    private static readonly object s_gate = new();
    private static readonly Dictionary<string, StoredEvidence> s_items = new(StringComparer.Ordinal);
    private static readonly LinkedList<string> s_order = [];

    internal static void Record(RuntimeCacheL1BoundaryEvidence evidence)
    {
        lock (s_gate)
        {
            if (!s_items.TryGetValue(evidence.RequestId, out StoredEvidence? stored))
            {
                LinkedListNode<string> node = s_order.AddLast(evidence.RequestId);
                stored = new StoredEvidence(node);
                s_items.Add(evidence.RequestId, stored);
            }
            stored.Items.Add(evidence);
            while (s_items.Count > Capacity && s_order.First is { } oldest)
            {
                s_order.RemoveFirst();
                s_items.Remove(oldest.Value);
            }
        }
    }

    internal static bool TryTake(string requestId, out IReadOnlyList<RuntimeCacheL1BoundaryEvidence> evidence)
    {
        lock (s_gate)
        {
            if (!s_items.Remove(requestId, out StoredEvidence? stored))
            {
                evidence = [];
                return false;
            }
            s_order.Remove(stored.Node);
            evidence = [.. stored.Items];
            return true;
        }
    }

    private sealed class StoredEvidence(LinkedListNode<string> node)
    {
        internal LinkedListNode<string> Node { get; } = node;
        internal List<RuntimeCacheL1BoundaryEvidence> Items { get; } = [];
    }
}
