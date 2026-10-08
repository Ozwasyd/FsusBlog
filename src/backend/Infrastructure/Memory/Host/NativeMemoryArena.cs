using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;

namespace FsusBlog.Server.Infrastructure.Memory.Host;

/// <summary>
/// Published initialized bytes in one block. Identity is independent of the raw
/// address. Captured Memory rejects access after its lease is disposed; previously
/// obtained spans and pin pointers must remain within that lease/token lifetime.
/// ReadOnlyMemory is an API boundary, not physical OS write protection.
/// </summary>
public sealed class NativeMemorySlice : IMemoryHostViewSource
{
    private readonly NativeMemoryBlock _block;

    internal NativeMemorySlice(NativeMemoryBlock block, MemoryContentIdentity content,
        MemoryLocationToken location, int offset, int length)
    {
        _block = block;
        Content = content;
        Location = location;
        Offset = offset;
        Length = length;
    }

    public MemoryContentIdentity Content
    {
        get;
    }
    public MemoryLocationToken Location
    {
        get;
    }
    public int Length
    {
        get;
    }
    internal int Offset
    {
        get;
    }
    public MemoryLifetimeSnapshot Snapshot() => _block.Snapshot();

    public MemoryOperationResult<IMemoryHostReadLease> TryAcquireHostView(MemoryLocationToken expectedLocation)
        => _block.Acquire(this, expectedLocation, 0, Length);

    public MemoryOperationResult<IMemoryHostReadLease> TryAcquireHostView(MemoryLocationToken expectedLocation, int offset, int length)
        => _block.Acquire(this, expectedLocation, offset, length);

    public MemoryOperationResult<IDisposable> TryRetainRole(MemoryLocationToken expectedLocation, MemoryRoleKind kind)
        => _block.Retain(expectedLocation, Location, kind);

    public ValueTask<MemoryOperationResult<MemoryOperationCompletion>> ConsumeAsync(MemoryLocationToken expectedLocation,
        Func<ReadOnlyMemory<byte>, CancellationToken, ValueTask> consumer, CancellationToken cancellationToken = default)
        => _block.ConsumeAsync(this, expectedLocation, consumer, cancellationToken);
}

/// <summary>Capacity and logical usage remain separate from sampled process RSS.</summary>
public sealed record NativeMemoryArenaSnapshot(long CapacityBytes, long LogicalBytes, long FragmentationBytes,
    long RetainedBytes, long AllocatorRelinquishedBytes, long? ObservedProcessResidentBytes);

/// <summary>
/// Owns sealed blocks until retirement. Dispose closes new acquisitions; Drained
/// completes only after every actual role, reader, pin and operation ends.
/// </summary>
public sealed class NativeMemoryArena : IDisposable
{
    private readonly NativeMemoryBlock[] _blocks;
    private readonly Task _drained;
    private int _closed;

    internal NativeMemoryArena(NativeMemoryBlock[] blocks, NativeMemorySlice[] slices)
    {
        _blocks = blocks;
        Slices = Array.AsReadOnly(slices);
        _drained = Task.WhenAll(blocks.Select(block => block.Drained));
    }

    public IReadOnlyList<NativeMemorySlice> Slices
    {
        get;
    }
    public Task Drained => _drained;

    public NativeMemoryArenaSnapshot Snapshot(long? observedProcessResidentBytes = null)
    {
        if (observedProcessResidentBytes < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(observedProcessResidentBytes));
        }
        long capacity = 0;
        long logical = 0;
        long retained = 0;
        long relinquished = 0;
        foreach (NativeMemoryBlock block in _blocks)
        {
            MemoryLifetimeSnapshot snapshot = block.Snapshot();
            capacity = checked(capacity + snapshot.Capacity);
            logical = checked(logical + snapshot.LogicalLength);
            if (block.AllocatorRelinquished)
            {
                relinquished = checked(relinquished + snapshot.Capacity);
            }
            else
            {
                retained = checked(retained + snapshot.Capacity);
            }
        }
        return new(capacity, logical, capacity - logical, retained, relinquished, observedProcessResidentBytes);
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _closed, 1) != 0)
        {
            return;
        }
        Exception? first = null;
        foreach (NativeMemoryBlock block in _blocks)
        {
            try
            {
                block.Close();
            }
            catch (Exception exception)
            {
                first ??= exception;
            }
        }
        if (first is not null)
        {
            throw new InvalidOperationException("Native arena retirement faulted.", first);
        }
    }
}
