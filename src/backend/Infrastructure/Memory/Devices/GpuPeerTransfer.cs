using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

public enum GpuPeerAllocationAccess
{
    Read,
    ExclusiveWrite
}

/// <summary>The allocation owner retains the backing, charge and device epoch for this hold.</summary>
public interface IGpuPeerAllocationHold : IDisposable
{
    IGpuDriverSession Session
    {
        get;
    }
    MemoryContentIdentity Content
    {
        get;
    }
    GpuPeerAllocationAccess Access
    {
        get;
    }
    MemoryLocationToken Location
    {
        get;
    }
    GpuDeviceAddress Address
    {
        get;
    }
    long Length
    {
        get;
    }
    bool IsCurrent
    {
        get;
    }
    /// <summary>The existing owner admits new use separately from retaining valid draining reads.</summary>
    bool CanSubmit
    {
        get;
    }
}

/// <summary>Peer copies use the same session and completion owner as ordinary GPU DMA.</summary>
public interface IGpuPeerDriverSession : IGpuDriverSession
{
    MemoryDetection DetectPeerAccess(IGpuPeerDriverSession destination);
    GpuSubmission SubmitPeerTransfer(GpuDeviceAddress source, IGpuPeerDriverSession destination,
        GpuDeviceAddress destinationAddress, long bytes);
}

/// <summary>Transferred owner holds remain retained after cancellation or uncertain native completion.</summary>
public sealed class GpuPeerTransfer : IDisposable
{
    private readonly object _gate = new();
    private readonly IGpuPeerDriverSession _sourceSession;
    private readonly IGpuPeerAllocationHold _source;
    private readonly IGpuPeerAllocationHold _destination;
    private readonly IDisposable _operationResources;
    private GpuSubmission _submission;
    private bool _released;
    private bool _quarantined;
    private MemoryFailure? _terminalFailure;
    public Exception? SubmissionFailure
    {
        get; private set;
    }

    private GpuPeerTransfer(IGpuPeerDriverSession sourceSession, IGpuPeerAllocationHold source,
        IGpuPeerAllocationHold destination, IDisposable operationResources)
    {
        _sourceSession = sourceSession;
        _source = source;
        _destination = destination;
        _operationResources = operationResources;
    }

    public bool IsQuarantined
    {
        get
        {
            lock (_gate)
            {
                return _quarantined;
            }
        }
    }
    public bool IsDrained
    {
        get
        {
            lock (_gate)
            {
                return _released;
            }
        }
    }

    /// <summary>Ownership of all holds transfers on invocation, including failed or uncertain submission.</summary>
    public static GpuPeerTransfer Submit(IGpuPeerDriverSession sourceSession, IGpuPeerDriverSession destinationSession,
        IGpuPeerAllocationHold source, IGpuPeerAllocationHold destination, long bytes, IDisposable operationResources)
    {
        ArgumentNullException.ThrowIfNull(sourceSession);
        ArgumentNullException.ThrowIfNull(destinationSession);
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(operationResources);
        var transfer = new GpuPeerTransfer(sourceSession, source, destination, operationResources);
        try
        {
            source.Location.Validate();
            destination.Location.Validate();
            source.Content.Validate();
            destination.Content.Validate();
            if (source.Content != destination.Content || source.Access != GpuPeerAllocationAccess.Read
                || destination.Access != GpuPeerAllocationAccess.ExclusiveWrite)
            {
                throw new InvalidOperationException("Peer transfer requires identical content and a read/exclusive-write owner pair.");
            }
            if (!ReferenceEquals(source.Session, sourceSession) || !ReferenceEquals(destination.Session, destinationSession))
            {
                throw new InvalidOperationException("Peer allocation belongs to a different driver session.");
            }
            if (!source.IsCurrent || !destination.IsCurrent)
            {
                throw new InvalidOperationException("Peer allocation epoch/location is stale.");
            }
            if (!source.CanSubmit || !destination.CanSubmit)
            {
                throw new InvalidOperationException("Peer allocation owner has stopped new submissions.");
            }
            if (bytes <= 0 || bytes != source.Length || bytes != destination.Length)
            {
                throw new ArgumentOutOfRangeException(nameof(bytes));
            }
        }
        catch
        {
            transfer.ReleaseHolds();
            throw;
        }
        try
        {
            transfer._submission = sourceSession.SubmitPeerTransfer(source.Address, destinationSession, destination.Address, bytes);
        }
        catch (Exception exception)
        {
            // A driver may have enqueued a copy before reporting an error. Keep the owner reachable.
            transfer._quarantined = true;
            transfer.SubmissionFailure = exception;
        }
        return transfer;
    }

    /// <summary>Polling does not abort DMA. Complete old-epoch results release safely but cannot publish success.</summary>
    public MemoryOperationResult<GpuPeerTransfer> Poll()
    {
        lock (_gate)
        {
            if (_quarantined)
            {
                return MemoryOperationResult<GpuPeerTransfer>.Reject(MemoryFailure.DeviceLost);
            }
            if (_released)
            {
                return _terminalFailure is { } failure ? MemoryOperationResult<GpuPeerTransfer>.Reject(failure)
                    : MemoryOperationResult<GpuPeerTransfer>.Success(this);
            }
            GpuCompletion completion;
            try
            {
                completion = _sourceSession.Query(_submission);
            }
            catch
            {
                _quarantined = true;
                return MemoryOperationResult<GpuPeerTransfer>.Reject(MemoryFailure.DeviceLost);
            }
            if (completion == GpuCompletion.Pending)
            {
                return MemoryOperationResult<GpuPeerTransfer>.Reject(MemoryFailure.TierUnavailable);
            }
            if (completion != GpuCompletion.Complete)
            {
                _quarantined = true;
                return MemoryOperationResult<GpuPeerTransfer>.Reject(MemoryFailure.DeviceLost);
            }
            bool current = _source.IsCurrent && _destination.IsCurrent;
            try
            {
                _sourceSession.ReleaseSubmission(_submission);
            }
            catch
            {
                _quarantined = true;
                return MemoryOperationResult<GpuPeerTransfer>.Reject(MemoryFailure.DeviceLost);
            }
            _terminalFailure = current ? null : MemoryFailure.StaleLocation;
            try
            {
                ReleaseHolds();
            }
            catch (Exception exception)
            {
                _quarantined = true;
                SubmissionFailure = exception;
                return MemoryOperationResult<GpuPeerTransfer>.Reject(MemoryFailure.DeviceLost);
            }
            return _terminalFailure is { } terminalFailure ? MemoryOperationResult<GpuPeerTransfer>.Reject(terminalFailure)
                : MemoryOperationResult<GpuPeerTransfer>.Success(this);
        }
    }

    // Outer cancellation/disposal only asks for a drain check. It never frees submitted resources.
    public void Dispose() => Poll();

    private void ReleaseHolds()
    {
        // Completion or pre-submit rejection proves slot release is safe. Release the vector
        // before the final allocation holds can finish either device owner's drain task.
        _operationResources.Dispose();
        _source.Dispose();
        _destination.Dispose();
        _released = true;
    }
}
