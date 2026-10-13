using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Devices;

public sealed record GpuMemoryDomains(ResourceDomainId Device, ResourceDomainId RegisteredHost,
    ResourceDomainId TransferSlots);

public sealed record GpuMemoryLimits(long MaximumAllocationBytes, long StagingAlignmentBytes,
    int MaximumAllocations, int MaximumStagingBuffers, int MaximumOperations);

public sealed record GpuMemorySnapshot(DeviceEpoch Epoch, bool Accepting, bool Faulted,
    int Allocations, int StagingBuffers, int Operations, int QuarantinedOperations, int UncertainReservations, bool RestartRequired);

/// <summary>
/// Owns admitted device allocations and driver-valid staging. The common governor owns
/// qualification, scheduling of PollCompletions, recovery policy and content eligibility.
/// No serving path is activated by constructing these source-level modules.
/// </summary>
public sealed class GpuMemoryDevice : IDisposable
{
    private readonly object _gate = new();
    private readonly IGpuDriverSession _driver;
    private readonly MemoryReservationCoordinator _ledger;
    private readonly GpuMemoryDomains _domains;
    private readonly GpuMemoryLimits _limits;
    private readonly HashSet<GpuAllocation> _allocations = [];
    private readonly List<GpuStagingBuffer> _staging = [];
    private readonly HashSet<GpuTransferOperation> _operations = [];
    private readonly HashSet<GpuPeerDeviceOperation> _peerOperations = [];
    private readonly List<IMemoryReservation> _uncertainReservations = [];
    private DeviceEpoch _epoch;
    private bool _accepting = true;
    private bool _faulted;
    private bool _disposed;
    private int _externalHolds;

    public GpuMemoryDevice(IGpuDriverSession driver, MemoryReservationCoordinator ledger,
        GpuMemoryDomains domains, GpuMemoryLimits limits, DeviceEpoch epoch, MemoryCapabilityStatus qualification)
    {
        ArgumentNullException.ThrowIfNull(driver);
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(domains);
        ArgumentNullException.ThrowIfNull(limits);
        ArgumentNullException.ThrowIfNull(qualification);
        MemoryCapabilityPolicy.Validate(qualification.Requested);
        if (qualification.PolicyRevision == 0 || qualification.Detection != MemoryDetection.Present
            || qualification.Requested == MemoryCapabilityMode.Disabled
            || qualification.ReleaseQualification != MemoryQualification.Qualified
            || qualification.RuntimeQualification != MemoryQualification.Qualified
            || qualification.OnlineState != MemoryOnlineState.Online)
        {
            throw new ArgumentException("The common capability owner must qualify and admit the session first.", nameof(qualification));
        }
        if (epoch.Value == 0 || limits.MaximumAllocationBytes <= 0 || limits.MaximumAllocations <= 0
            || limits.MaximumStagingBuffers <= 0 || limits.MaximumOperations <= 0
            || limits.StagingAlignmentBytes <= 0 || (limits.StagingAlignmentBytes & (limits.StagingAlignmentBytes - 1)) != 0)
        {
            throw new ArgumentOutOfRangeException(nameof(limits));
        }
        // UMA must be represented by the common topology, never treated as extra host capacity.
        if (driver.Identity.SharesHostCapacity
            && !ledger.Topology.ConstraintChain(domains.Device).Select(domain => domain.CapacityIdentity)
                .Intersect(ledger.Topology.ConstraintChain(domains.RegisteredHost).Select(domain => domain.CapacityIdentity), StringComparer.Ordinal).Any())
        {
            throw new ArgumentException("Shared device capacity requires shared physical-domain accounting.", nameof(domains));
        }
        _driver = driver;
        _ledger = ledger;
        _domains = domains;
        _limits = limits;
        _epoch = epoch;
    }

    public GpuDeviceIdentity Identity => _driver.Identity;
    internal IGpuDriverSession Driver => _driver;
    internal MemoryReservationCoordinator Ledger => _ledger;
    internal ResourceDomainId TransferDomain => _domains.TransferSlots;

    public GpuMemorySnapshot Snapshot()
    {
        lock (_gate)
        {
            int quarantined = _operations.Count(operation => operation.Quarantined)
                + _peerOperations.Count(operation => operation.Quarantined);
            return new(_epoch, _accepting, _faulted, _allocations.Count, _staging.Count,
                _operations.Count + _peerOperations.Count + _externalHolds, quarantined, _uncertainReservations.Count, _faulted);
        }
    }

    public MemoryOperationResult<GpuAllocation> TryAllocate(MemoryContentIdentity content, long length,
        ResidencyRevision revision)
    {
        content.Validate();
        if (length <= 0 || length > _limits.MaximumAllocationBytes || revision.Value == 0)
        {
            return MemoryOperationResult<GpuAllocation>.Reject(MemoryFailure.BoundsViolation);
        }
        lock (_gate)
        {
            if (!_accepting)
            {
                return MemoryOperationResult<GpuAllocation>.Reject(_faulted ? MemoryFailure.DeviceLost : MemoryFailure.TierUnavailable);
            }
            if (_allocations.Count >= _limits.MaximumAllocations)
            {
                return MemoryOperationResult<GpuAllocation>.Reject(MemoryFailure.BudgetRejected);
            }
            MemoryResourceCharge[] vector = [new(_domains.Device, MemoryResourceUnit.Bytes, length)];
            var admission = _ledger.TryReserve(vector);
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<GpuAllocation>.Reject(admission.Failure!.Value);
            }
            var reservation = admission.Value!;
            GpuDeviceAddress address;
            try
            {
                address = _driver.AllocateDevice(length);
            }
            catch (GpuAllocationRejectedException)
            {
                reservation.Dispose();
                return MemoryOperationResult<GpuAllocation>.Reject(MemoryFailure.BudgetRejected);
            }
            catch
            {
                // A native call can allocate successfully and then fail context restoration.
                // There is no returned handle proving safe release; retain admission and stop.
                _uncertainReservations.Add(reservation);
                FaultLocked();
                return MemoryOperationResult<GpuAllocation>.Reject(MemoryFailure.DeviceLost);
            }
            var location = new MemoryLocationToken(new(Guid.NewGuid()), new(Guid.NewGuid()), revision, _epoch);
            var descriptor = new MemoryAllocationDescriptor(location.Allocation, _domains.Device,
                MemoryAllocationLayout.TryCreate(length, length, 1).Value!);
            var conversion = reservation.CommitPhysical(descriptor, vector);
            // A conversion failure retains the reservation and native owner, not uncharged backing.
            var allocation = new GpuAllocation(this, content, location, address, length,
                conversion.Value, conversion.Succeeded ? null : reservation);
            _allocations.Add(allocation);
            if (!conversion.Succeeded)
            {
                FaultLocked();
                allocation.Retiring = true;
                return MemoryOperationResult<GpuAllocation>.Reject(conversion.Failure!.Value);
            }
            return MemoryOperationResult<GpuAllocation>.Success(allocation);
        }
    }

    /// <summary>Success transfers custody of source to the actual operation; rejection leaves it with the caller.</summary>
    public MemoryOperationResult<GpuTransferOperation> TryUpload(GpuAllocation destination,
        IMemoryHostReadLease source, MemoryLocationToken expectedDestination)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);
        // Content authority/eligibility is still checked by the residency publisher before publication.
        if (source.Content != destination.Content || source.Memory.Length != destination.Length)
        {
            return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.BoundsViolation);
        }
        return Submit(destination, expectedDestination, source, readback: false);
    }

    /// <summary>Copies one complete immutable representation into an exclusive, unpublished destination.</summary>
    public MemoryOperationResult<GpuPeerDeviceOperation> TryPeerUpload(GpuAllocation destination,
        GpuAllocation source, MemoryCapabilityStatus peerStatus, GpuPeerCapabilityFacts facts, MemoryQualification workloadQualification,
        string workloadReason)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(peerStatus);
        var selection = GpuPeerPathSelection.Select(peerStatus, facts, GpuPeerPath.PeerTransfer,
            workloadQualification, MemoryAdmission.Admitted, workloadReason);
        if (selection.Path != GpuPeerPath.PeerTransfer)
        {
            return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.UnsupportedCapability);
        }
        if (!ReferenceEquals(_ledger, source.Ledger))
        {
            return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.OwnershipViolation);
        }
        if (destination.Content != source.Content)
        {
            return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.Corruption);
        }
        if (destination.Length != source.Length)
        {
            return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.BoundsViolation);
        }
        if (_driver is not IGpuPeerDriverSession destinationSession
            || source.Driver is not IGpuPeerDriverSession sourceSession)
        {
            return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.UnsupportedCapability);
        }
        var retainedSource = source.TryAcquirePeerHold(source.Location);
        if (!retainedSource.Succeeded)
        {
            return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(retainedSource.Failure!.Value);
        }
        IGpuPeerAllocationHold sourceHold = retainedSource.Value!;
        GpuAllocationHold destinationHold;
        MemoryReservation reservation;
        GpuPeerDeviceOperation operation;
        bool custodyTransferred = false;
        try
        {
            lock (_gate)
            {
                if (!_accepting || !IsCurrentLocked(destination) || destination.Retiring
                    || destination.UploadSubmitted || destination.Holds != 0)
                {
                    return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.StaleLocation);
                }
                if (_operations.Count + _peerOperations.Count + _externalHolds >= _limits.MaximumOperations)
                {
                    return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(MemoryFailure.BudgetRejected);
                }
                MemoryResourceCharge[] vector = source.TransferDomain == _domains.TransferSlots
                    ? [new(_domains.TransferSlots, MemoryResourceUnit.OperationSlots, 1)]
                    : [new(_domains.TransferSlots, MemoryResourceUnit.OperationSlots, 1), new(source.TransferDomain, MemoryResourceUnit.OperationSlots, 1)];
                var admission = _ledger.TryReserve(vector);
                if (!admission.Succeeded)
                {
                    return MemoryOperationResult<GpuPeerDeviceOperation>.Reject(admission.Failure!.Value);
                }
                reservation = admission.Value!;
                destination.Holds++;
                destination.UploadSubmitted = true;
                destinationHold = new GpuAllocationHold(this, destination, GpuPeerAllocationAccess.ExclusiveWrite);
                operation = new GpuPeerDeviceOperation(source, destination);
                _peerOperations.Add(operation);
            }
            // Never hold one device gate while checking or invoking the other device owner.
            try
            {
                custodyTransferred = true;
                GpuPeerTransfer transfer = GpuPeerTransfer.Submit(sourceSession, destinationSession,
                    sourceHold, destinationHold, destination.Length, reservation);
                bool quarantined = transfer.IsQuarantined;
                if (quarantined)
                {
                    source.InvalidateOwner();
                }
                lock (_gate)
                {
                    operation.Transfer = transfer;
                    operation.Quarantined = quarantined;
                    if (quarantined)
                    {
                        FaultLocked();
                        operation.Finish(MemoryFailure.DeviceLost);
                    }
                }
                return MemoryOperationResult<GpuPeerDeviceOperation>.Success(operation);
            }
            catch
            {
                // Pre-submit validation released all supplied holds and the reservation.
                lock (_gate)
                {
                    _peerOperations.Remove(operation);
                    destination.UploadSubmitted = false;
                }
                throw;
            }
        }
        finally
        {
            if (!custodyTransferred)
            {
                sourceHold.Dispose();
            }
        }
    }

    public MemoryOperationResult<GpuTransferOperation> TryReadback(GpuAllocation source, MemoryLocationToken expectedSource)
    {
        ArgumentNullException.ThrowIfNull(source);
        return Submit(source, expectedSource, null, readback: true);
    }

    private MemoryOperationResult<GpuTransferOperation> Submit(GpuAllocation allocation,
        MemoryLocationToken expected, IMemoryHostReadLease? source, bool readback)
    {
        lock (_gate)
        {
            if (!_accepting || !IsCurrentLocked(allocation) || allocation.Location != expected || allocation.Retiring
                || (readback ? !allocation.Initialized : allocation.UploadSubmitted))
            {
                return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.StaleLocation);
            }
            if (_operations.Count + _peerOperations.Count + _externalHolds >= _limits.MaximumOperations)
            {
                return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.BudgetRejected);
            }
            var planned = MemoryAllocationLayout.TryPlan(allocation.Length, 1, _limits.StagingAlignmentBytes,
                _limits.MaximumAllocationBytes);
            if (!planned.Succeeded || allocation.Length > int.MaxValue)
            {
                return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.BoundsViolation);
            }
            long capacity = planned.Value!.CapacityBytes;
            GpuStagingBuffer? staging = _staging.FirstOrDefault(buffer => !buffer.Busy
                && buffer.Capacity == capacity && buffer.Readback == readback);
            if (staging is null && _staging.Count >= _limits.MaximumStagingBuffers)
            {
                return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.BudgetRejected);
            }
            // New staging bytes and transfer slots are one all-or-nothing vector. Existing
            // staging is already charged; its pool retention never fabricates free headroom.
            MemoryResourceCharge[] vector = staging is null
                ? [new(_domains.RegisteredHost, MemoryResourceUnit.Bytes, capacity), new(_domains.TransferSlots, MemoryResourceUnit.OperationSlots, 1)]
                : [new(_domains.TransferSlots, MemoryResourceUnit.OperationSlots, 1)];
            var admission = _ledger.TryReserve(vector);
            if (!admission.Succeeded)
            {
                return MemoryOperationResult<GpuTransferOperation>.Reject(admission.Failure!.Value);
            }
            var reservation = admission.Value!;
            bool newlyAllocated = staging is null;
            if (staging is null)
            {
                try
                {
                    staging = new GpuStagingBuffer(_driver.AllocateHost(capacity, readback), capacity, readback);
                    _staging.Add(staging);
                }
                catch (GpuAllocationRejectedException)
                {
                    reservation.Dispose();
                    return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.BudgetRejected);
                }
                catch
                {
                    _uncertainReservations.Add(reservation);
                    FaultLocked();
                    return MemoryOperationResult<GpuTransferOperation>.Reject(MemoryFailure.DeviceLost);
                }
            }
            // This reservation remains an operation owner; on completion its staging
            // bytes are converted to a retained physical charge before returning to pool.
            var operation = new GpuTransferOperation(this, allocation, staging, source, reservation, newlyAllocated, readback);
            staging.Busy = true;
            allocation.Holds++;
            _operations.Add(operation);
            try
            {
                if (source is not null)
                {
                    _driver.WriteHost(staging.Address, source.Memory.Span);
                }
            }
            catch
            {
                // No driver submission was attempted; cleanup is safe only if native free succeeds.
                operation.Source = null;
                CompleteLocked(operation, MemoryFailure.OwnershipViolation);
                FaultLocked();
                throw;
            }
            try
            {
                allocation.UploadSubmitted |= !readback;
                operation.Submission = readback
                    ? _driver.SubmitReadback(allocation.Address, staging.Address, allocation.Length)
                    : _driver.SubmitUpload(staging.Address, allocation.Address, allocation.Length);
                operation.Submitted = true;
            }
            catch
            {
                // Submission can fail after DMA entered the driver. Keep every owner and
                // reject new work; no unbounded retries/new epochs are allowed here.
                operation.Quarantined = true;
                FaultLocked();
                operation.Finish(MemoryFailure.DeviceLost);
            }
            return MemoryOperationResult<GpuTransferOperation>.Success(operation);
        }
    }

    /// <summary>Bounded synchronous poll; the common scheduler owns cadence and recovery.</summary>
    public void PollCompletions()
    {
        lock (_gate)
        {
            foreach (GpuTransferOperation operation in _operations.ToArray())
            {
                if (!operation.Submitted || operation.DriverComplete)
                {
                    continue;
                }
                GpuCompletion completion;
                try
                {
                    completion = _driver.Query(operation.Submission);
                }
                catch
                {
                    completion = GpuCompletion.Uncertain;
                }
                if (completion == GpuCompletion.Pending)
                {
                    continue;
                }
                if (completion == GpuCompletion.Uncertain)
                {
                    operation.Quarantined = true;
                    FaultLocked();
                    operation.Finish(MemoryFailure.DeviceLost);
                    continue;
                }
                operation.DriverComplete = true;
                try
                {
                    _driver.ReleaseSubmission(operation.Submission);
                }
                catch
                {
                    operation.Quarantined = true;
                    FaultLocked();
                    operation.Finish(MemoryFailure.DeviceLost);
                    continue;
                }
                if (!operation.Readback || operation.ReleaseRequested || !IsCurrentLocked(operation.Allocation))
                {
                    if (!operation.Readback && IsCurrentLocked(operation.Allocation))
                    {
                        operation.Allocation.Initialized = true;
                    }
                    CompleteLocked(operation, IsCurrentLocked(operation.Allocation) ? null : MemoryFailure.DeviceLost);
                }
                else
                {
                    // The readback consumer retains staging and its slot until explicit disposal.
                    operation.Finish(null);
                }
            }
            DrainLocked();
        }
        GpuPeerDeviceOperation[] peers;
        lock (_gate)
        {
            peers = _peerOperations.ToArray();
        }
        foreach (GpuPeerDeviceOperation operation in peers)
        {
            GpuPeerTransfer? transfer;
            lock (_gate)
            {
                transfer = operation.Transfer;
            }
            if (transfer is null)
            {
                continue;
            }
            var completion = transfer.Poll();
            if (completion.Failure == MemoryFailure.TierUnavailable)
            {
                continue;
            }
            bool quarantined = transfer.IsQuarantined;
            if (quarantined)
            {
                operation.Source.InvalidateOwner();
            }
            lock (_gate)
            {
                if (!_peerOperations.Contains(operation))
                {
                    continue;
                }
                if (quarantined)
                {
                    operation.Quarantined = true;
                    FaultLocked();
                    operation.Finish(MemoryFailure.DeviceLost);
                    continue;
                }
                bool current = IsCurrentLocked(operation.Destination);
                operation.Destination.Initialized = completion.Succeeded && current;
                _peerOperations.Remove(operation);
                operation.Finish(completion.Succeeded && !current ? MemoryFailure.StaleLocation : completion.Failure);
                DrainLocked();
            }
        }
    }

    public void InvalidateEpoch()
    {
        lock (_gate)
        {
            FaultLocked();
            foreach (GpuPeerDeviceOperation operation in _peerOperations)
            {
                operation.Quarantined = true;
                operation.Finish(MemoryFailure.DeviceLost);
            }
            foreach (GpuTransferOperation operation in _operations)
            {
                operation.Quarantined = !operation.DriverComplete;
                operation.Finish(MemoryFailure.DeviceLost);
            }
        }
    }

    internal bool IsCurrent(GpuAllocation allocation)
    {
        lock (_gate)
        {
            return IsCurrentLocked(allocation);
        }
    }

    internal bool CanSubmit(GpuAllocation allocation)
    {
        lock (_gate)
        {
            return _accepting && !allocation.Retiring && IsCurrentLocked(allocation);
        }
    }

    private bool IsCurrentLocked(GpuAllocation allocation)
        => !_faulted && !_disposed && allocation.Location.Epoch == _epoch && _allocations.Contains(allocation);

    private void FaultLocked()
    {
        if (!_faulted)
        {
            // Never wrap an exhausted epoch into a potentially valid old identity.
            if (_epoch.Value < ulong.MaxValue)
            {
                _epoch = new(_epoch.Value + 1);
            }
            _faulted = true;
            _accepting = false;
        }
    }

    internal void Retire(GpuAllocation allocation)
    {
        lock (_gate)
        {
            allocation.Retiring = true;
            DrainLocked();
        }
    }

    internal MemoryOperationResult<IGpuPeerAllocationHold> TryRetain(GpuAllocation allocation, MemoryLocationToken expected)
    {
        lock (_gate)
        {
            if (!_accepting || !IsCurrentLocked(allocation) || allocation.Retiring || !allocation.Initialized || allocation.Location != expected)
            {
                return MemoryOperationResult<IGpuPeerAllocationHold>.Reject(MemoryFailure.StaleLocation);
            }
            if (allocation.Holds >= _limits.MaximumOperations
                || _operations.Count + _peerOperations.Count + _externalHolds >= _limits.MaximumOperations)
            {
                return MemoryOperationResult<IGpuPeerAllocationHold>.Reject(MemoryFailure.BudgetRejected);
            }
            allocation.Holds++;
            _externalHolds++;
            return MemoryOperationResult<IGpuPeerAllocationHold>.Success(new GpuAllocationHold(this, allocation, GpuPeerAllocationAccess.Read));
        }
    }

    internal void ReleaseHold(GpuAllocation allocation, bool external)
    {
        lock (_gate)
        {
            allocation.Holds--;
            if (external)
            {
                _externalHolds--;
            }
            DrainLocked();
        }
    }

    internal void CopyReadback(GpuTransferOperation operation, Span<byte> destination)
    {
        lock (_gate)
        {
            if (!_operations.Contains(operation) || !operation.Readback || !operation.DriverComplete
                || operation.Quarantined || operation.ReleaseRequested || !IsCurrentLocked(operation.Allocation))
            {
                throw new InvalidOperationException("Readback requires current completed operation custody.");
            }
            if (destination.Length != operation.Allocation.Length)
            {
                throw new ArgumentException("The complete payload must be delivered to its admitted response owner.", nameof(destination));
            }
            try
            {
                _driver.ReadHost(operation.Staging.Address, destination);
            }
            catch
            {
                operation.Quarantined = true;
                FaultLocked();
                throw;
            }
        }
    }

    internal void ReleaseOperation(GpuTransferOperation operation)
    {
        lock (_gate)
        {
            operation.ReleaseRequested = true;
            if (operation.DriverComplete && !operation.Quarantined && _operations.Contains(operation))
            {
                CompleteLocked(operation, IsCurrentLocked(operation.Allocation) ? null : MemoryFailure.DeviceLost);
                DrainLocked();
            }
        }
    }

    private void CompleteLocked(GpuTransferOperation operation, MemoryFailure? failure)
    {
        if (operation.NewStaging)
        {
            var vector = new MemoryResourceCharge[] { new(_domains.RegisteredHost, MemoryResourceUnit.Bytes, operation.Staging.Capacity) };
            var descriptor = new MemoryAllocationDescriptor(new(Guid.NewGuid()), _domains.RegisteredHost,
                MemoryAllocationLayout.TryCreate(operation.Allocation.Length, operation.Staging.Capacity, _limits.StagingAlignmentBytes).Value!);
            var conversion = operation.Reservation.CommitPhysical(descriptor, vector);
            if (!conversion.Succeeded)
            {
                operation.Quarantined = true;
                FaultLocked();
                operation.Finish(conversion.Failure);
                return;
            }
            operation.Staging.Charge = conversion.Value;
        }
        else
        {
            operation.Reservation.Dispose();
        }
        operation.Source?.Dispose();
        operation.Staging.Busy = false;
        operation.Allocation.Holds--;
        _operations.Remove(operation);
        operation.Finish(failure);
    }

    private void DrainLocked()
    {
        foreach (GpuAllocation allocation in _allocations.Where(value => value.Retiring && value.Holds == 0).ToArray())
        {
            // A faulted context has no proof that driver resources are safe to free.
            if (_faulted)
            {
                break;
            }
            try
            {
                _driver.FreeDevice(allocation.Address);
                allocation.Charge?.Dispose();
                allocation.Unconverted?.Dispose();
                _allocations.Remove(allocation);
            }
            catch
            {
                FaultLocked();
                break;
            }
        }
        if (!_accepting && !_faulted)
        {
            foreach (GpuStagingBuffer buffer in _staging.Where(value => !value.Busy).ToArray())
            {
                try
                {
                    _driver.FreeHost(buffer.Address);
                    buffer.Charge!.Dispose();
                    _staging.Remove(buffer);
                }
                catch
                {
                    FaultLocked();
                    break;
                }
            }
            if (!_faulted && _operations.Count == 0 && _peerOperations.Count == 0 && _allocations.Count == 0 && _staging.Count == 0 && !_disposed)
            {
                try
                {
                    _driver.Dispose();
                    _disposed = true;
                }
                catch
                {
                    // Context teardown may have partly completed; never guess it is retry-safe.
                    FaultLocked();
                }
            }
        }
    }

    /// <summary>Stop new use and drain confirmed work; faulted resources require the declared controlled restart owner.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            _accepting = false;
            foreach (GpuAllocation allocation in _allocations)
            {
                allocation.Retiring = true;
            }
            foreach (GpuTransferOperation operation in _operations.ToArray())
            {
                operation.ReleaseRequested = true;
                if (operation.DriverComplete && !operation.Quarantined)
                {
                    CompleteLocked(operation, IsCurrentLocked(operation.Allocation) ? null : MemoryFailure.DeviceLost);
                }
            }
            DrainLocked();
        }
    }
}

internal sealed class GpuStagingBuffer(GpuHostAddress address, long capacity, bool readback)
{
    public GpuHostAddress Address { get; } = address;
    public long Capacity { get; } = capacity;
    public bool Readback { get; } = readback;
    public bool Busy
    {
        get; set;
    }
    public IMemoryAllocationCharge? Charge
    {
        get; set;
    }
}
