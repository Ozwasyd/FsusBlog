using System.Data.Common;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Lifetime;

namespace FsusBlog.Server.Infrastructure.Memory.Transient;

/// <summary>
/// Registered upper bounds for one existing database operation. Workspace includes every
/// simultaneous controlled representation; runtime/provider overhead remains observed headroom.
/// </summary>
public sealed record DatabaseMaterializationBounds(
    int MaximumRows,
    int MaximumStringCharacters,
    int MaximumFrameBytes,
    long MaximumWorkspaceBytes);

/// <summary>
/// Admission and bound enforcement around the actual asynchronous materializer, without
/// owning transactions, query order, authorization or provider-internal allocation.
/// </summary>
public sealed class DatabaseMaterializationScope
{
    private readonly DatabaseMaterializationBounds _bounds;
    private long _materializedBytes;
    private int _rows;
    private long _remainingRowBytes;
    private bool _active = true;
    private readonly object _gate = new();

    private DatabaseMaterializationScope(DatabaseMaterializationBounds bounds) => _bounds = bounds;

    /// <summary>
    /// Reserves before invoking the query/materializer and holds through its real completion.
    /// Results must be consumed or transferred to another charged owner inside the callback.
    /// </summary>
    public static async ValueTask<MemoryOperationResult<MemoryOperationCompletion>> RunAsync(
        MemoryReservationCoordinator ledger, ResourceDomainId workspaceDomain, ResourceDomainId operationDomain,
        DatabaseMaterializationBounds bounds,
        Func<DatabaseMaterializationScope, CancellationToken, ValueTask> materialize,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(bounds);
        ArgumentNullException.ThrowIfNull(materialize);
        if (bounds.MaximumRows <= 0 || bounds.MaximumStringCharacters <= 0
            || bounds.MaximumStringCharacters > Array.MaxLength || bounds.MaximumFrameBytes <= 0
            || bounds.MaximumWorkspaceBytes < bounds.MaximumFrameBytes
            || bounds.MaximumWorkspaceBytes < (long)bounds.MaximumStringCharacters * sizeof(char) * 2)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(MemoryFailure.BoundsViolation);
        }
        if (cancellationToken.IsCancellationRequested)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(MemoryFailure.Cancelled);
        }
        MemoryOperationResult<MemoryReservation> admission = ledger.TryReserve([
            new(workspaceDomain, MemoryResourceUnit.Bytes, bounds.MaximumWorkspaceBytes),
            new(operationDomain, MemoryResourceUnit.OperationSlots, 1)
        ]);
        if (!admission.Succeeded)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(admission.Failure!.Value);
        }
        using MemoryReservation reservation = admission.Value!;
        var scope = new DatabaseMaterializationScope(bounds);
        try
        {
            await materialize(scope, cancellationToken).ConfigureAwait(false);
            return MemoryOperationResult<MemoryOperationCompletion>.Success(MemoryOperationCompletion.Completed);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return MemoryOperationResult<MemoryOperationCompletion>.Reject(MemoryFailure.Cancelled);
        }
        finally
        {
            lock (scope._gate)
            {
                scope._active = false;
            }
        }
    }

    /// <summary>Called before projecting each row, including its registered retained byte bound.</summary>
    public void AdmitRow(long maximumRetainedBytes)
    {
        lock (_gate)
        {
            RequireActive();
            if (_rows >= _bounds.MaximumRows)
            {
                throw new InvalidDataException("The registered database row bound was exceeded.");
            }
            AdmitBytes(maximumRetainedBytes);
            _remainingRowBytes = maximumRetainedBytes;
            _rows++;
        }
    }

    /// <summary>Checks a frame before its buffer is allocated, within the same workspace reservation.</summary>
    public void AdmitFrame(int bytes)
    {
        lock (_gate)
        {
            RequireActive();
            if (bytes <= 0 || bytes > _bounds.MaximumFrameBytes)
            {
                throw new InvalidDataException("The registered database frame bound was exceeded.");
            }
            AdmitBytes(bytes);
        }
    }

    /// <summary>
    /// Uses the provider's length probe before allocating. The row registration already
    /// includes retained string bytes; temporary characters and the new string overlap.
    /// Call inside the same sequential query/transaction callback.
    /// </summary>
    public string ReadBoundedString(DbDataReader reader, int ordinal)
    {
        ArgumentNullException.ThrowIfNull(reader);
        lock (_gate)
        {
            RequireActive();
            long length = reader.GetChars(ordinal, 0, null, 0, 0);
            if (length < 0 || length > _bounds.MaximumStringCharacters
                || length * sizeof(char) > _remainingRowBytes
                || length * sizeof(char) > _bounds.MaximumWorkspaceBytes - _materializedBytes)
            {
                throw new InvalidDataException("The registered database string/workspace bound was exceeded.");
            }
            if (length == 0)
            {
                return string.Empty;
            }
            char[] characters = new char[(int)length];
            try
            {
                int offset = 0;
                while (offset < characters.Length)
                {
                    long read = reader.GetChars(ordinal, offset, characters, offset, characters.Length - offset);
                    if (read <= 0 || read > characters.Length - offset)
                    {
                        throw new InvalidDataException("The database string length changed during materialization.");
                    }
                    offset += (int)read;
                }
                string value = new(characters);
                _remainingRowBytes -= length * sizeof(char);
                return value;
            }
            finally
            {
                Array.Clear(characters);
            }
        }
    }

    private void AdmitBytes(long bytes)
    {
        if (bytes <= 0 || bytes > _bounds.MaximumWorkspaceBytes - _materializedBytes)
        {
            throw new InvalidDataException("The registered database workspace bound was exceeded.");
        }
        _materializedBytes += bytes;
    }

    private void RequireActive() => ObjectDisposedException.ThrowIf(!_active, this);
}
