using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>Persistent inode ownership is independent of transient I/O slots; reads request zero inodes.</summary>
public sealed record DiskBudgetRequest(long DiskBytes, long HostBytes, long OperationSlots, long PersistentInodes = 0);

/// <summary>Unknown layering cannot certify capacity independent of host memory.</summary>
public enum DiskBackingKind
{
    Unknown,
    MemoryBacked,
    Independent
}

/// <summary>One scoped, time-bounded observation; quota/inode unknowns remain explicit.</summary>
public sealed record DiskCapacityObservation(
    string CapacityIdentity,
    MemoryResourceObservation AvailableBytes,
    MemoryResourceObservation QuotaBytes,
    MemoryResourceObservation AvailableInodes,
    DiskBackingKind Backing,
    DateTimeOffset ValidUntil,
    ulong PolicyRevision);

/// <summary>
/// Consumes the existing coordinator. The policy owner registers an application disk domain
/// contained by its volume/quota domain, and installs conservative caps before publishing a sample.
/// This adapter cannot revise limits or create an independent accounting authority.
/// </summary>
public sealed class DiskBudgetAdmission
{
    private readonly MemoryReservationCoordinator _coordinator;
    private readonly ResourceDomainId _capacityDomain;
    private readonly ResourceDomainId _inodeCapacityDomain;
    private readonly Func<DiskCapacityObservation> _observe;
    private readonly TimeProvider _timeProvider;
    private readonly long _safetyReserveBytes;
    private readonly long _applicationCapBytes;

    public DiskBudgetAdmission(MemoryReservationCoordinator coordinator, ResourceDomainId diskDomain,
        ResourceDomainId capacityDomain, ResourceDomainId hostDomain, ResourceDomainId slotDomain,
        ResourceDomainId inodeDomain, ResourceDomainId inodeCapacityDomain,
        long applicationCapBytes, long safetyReserveBytes, Func<DiskCapacityObservation> observe,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(coordinator);
        ArgumentNullException.ThrowIfNull(observe);
        if (applicationCapBytes <= 0 || safetyReserveBytes < 0
            || diskDomain == hostDomain || diskDomain == slotDomain || hostDomain == slotDomain
            || coordinator.Topology.Unit(diskDomain) != MemoryResourceUnit.Bytes
            || coordinator.Topology.Unit(capacityDomain) != MemoryResourceUnit.Bytes
            || coordinator.Topology.Unit(hostDomain) != MemoryResourceUnit.Bytes
            || coordinator.Topology.Unit(slotDomain) != MemoryResourceUnit.OperationSlots
            || coordinator.Topology.Unit(inodeDomain) != MemoryResourceUnit.Inodes
            || coordinator.Topology.Unit(inodeCapacityDomain) != MemoryResourceUnit.Inodes
            || !coordinator.Topology.ConstraintChain(diskDomain).Any(domain => domain.Id == capacityDomain)
            || !coordinator.Topology.ConstraintChain(inodeDomain).Any(domain => domain.Id == inodeCapacityDomain)
            || coordinator.Topology.ConstraintChain(diskDomain).Select(domain => domain.CapacityIdentity)
                .Intersect(coordinator.Topology.ConstraintChain(hostDomain).Select(domain => domain.CapacityIdentity),
                    StringComparer.Ordinal).Any())
        {
            throw new ArgumentException("Disk admission requires independent host, I/O and inode domains with containing shared capacities.");
        }
        _coordinator = coordinator;
        _capacityDomain = capacityDomain;
        _inodeCapacityDomain = inodeCapacityDomain;
        _observe = observe;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _safetyReserveBytes = safetyReserveBytes;
        _applicationCapBytes = applicationCapBytes;
        DiskDomain = diskDomain;
        HostDomain = hostDomain;
        SlotDomain = slotDomain;
        InodeDomain = inodeDomain;
    }

    public ResourceDomainId DiskDomain
    {
        get;
    }
    public ResourceDomainId HostDomain
    {
        get;
    }
    public ResourceDomainId SlotDomain
    {
        get;
    }

    internal ulong PolicyRevision => _coordinator.Snapshot().PolicyRevision;

    public ResourceDomainId InodeDomain
    {
        get;
    }

    public MemoryOperationResult<MemoryReservation> TryReserve(DiskBudgetRequest request)
        => TryReserveCore(request, false);

    // The recovery operation already owns its I/O slot and scratch. Its new retained
    // index needs host admission without granting capacity to create a disk file.
    internal MemoryOperationResult<MemoryReservation> TryReserveIndex(long hostBytes)
        => TryReserveCore(new(0, hostBytes, 0), true);

    private MemoryOperationResult<MemoryReservation> TryReserveCore(DiskBudgetRequest request, bool indexOnly)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.DiskBytes < 0 || request.HostBytes <= 0 || request.OperationSlots < 0
            || (!indexOnly && request.OperationSlots == 0) || request.PersistentInodes < 0
            || (request.DiskBytes > 0 && request.PersistentInodes == 0))
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BoundsViolation);
        }
        DiskCapacityObservation sample;
        try
        {
            sample = _observe();
        }
        catch (DiskFileSystemException exception)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(exception.OperationFailure);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.TierUnavailable);
        }
        DateTimeOffset now = _timeProvider.GetUtcNow();
        string capacityIdentity = _coordinator.Topology.CapacityIdentity(_capacityDomain);
        if (sample.Backing != DiskBackingKind.Independent || sample.PolicyRevision == 0 || sample.CapacityIdentity != capacityIdentity
            || sample.ValidUntil <= now || !Usable(sample.AvailableBytes, now, _capacityDomain)
            || !Usable(sample.QuotaBytes, now, _capacityDomain)
            || (request.PersistentInodes > 0 && !Usable(sample.AvailableInodes, now, _inodeCapacityDomain))
            || sample.AvailableBytes.Unit != MemoryResourceUnit.Bytes
            || sample.QuotaBytes.Unit != MemoryResourceUnit.Bytes
            || sample.AvailableInodes.Domain != _inodeCapacityDomain
            || sample.AvailableInodes.Unit != MemoryResourceUnit.Inodes)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.TierUnavailable);
        }
        long headroom = Math.Min(sample.AvailableBytes.Value!.Value, sample.QuotaBytes.Value!.Value);
        bool diskGrowth = request.DiskBytes > 0;
        if ((diskGrowth && headroom < _safetyReserveBytes) || (request.PersistentInodes > 0
            && sample.AvailableInodes.Value!.Value < request.PersistentInodes))
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
        }
        long capacityCap = diskGrowth ? headroom - _safetyReserveBytes : 0;
        if (!CapsBoundToSample(_coordinator.Snapshot(), sample, capacityCap, diskGrowth, request.PersistentInodes > 0))
        {
            // A new lower free-space sample is not an exclusive grant. The common policy
            // owner must reduce its shared cap; existing charges remain until actual deletion.
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
        }
        var vector = new List<MemoryResourceCharge>(4)
        {
            new(HostDomain, MemoryResourceUnit.Bytes, request.HostBytes)
        };
        if (request.OperationSlots > 0)
        {
            vector.Add(new(SlotDomain, MemoryResourceUnit.OperationSlots, request.OperationSlots));
        }
        if (request.DiskBytes > 0)
        {
            vector.Add(new(DiskDomain, MemoryResourceUnit.Bytes, request.DiskBytes));
        }
        if (request.PersistentInodes > 0)
        {
            vector.Add(new(InodeDomain, MemoryResourceUnit.Inodes, request.PersistentInodes));
        }
        MemoryOperationResult<MemoryReservation> result = _coordinator.TryReserve(vector);
        if (!result.Succeeded)
        {
            return result;
        }
        // Bind against concurrent owner policy changes without touching the owner's limits.
        // Failed revalidation releases this token only; live allocations are never fabricated away.
        if (!CapsBoundToSample(_coordinator.Snapshot(), sample, capacityCap, diskGrowth, request.PersistentInodes > 0))
        {
            result.Value!.Dispose();
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
        }
        return result;
    }

    private bool CapsBoundToSample(MemoryAccountingSnapshot snapshot, DiskCapacityObservation sample, long capacityCap,
        bool diskGrowth, bool inodeGrowth)
    {
        string capacityKey = _coordinator.Topology.CapacityIdentity(_capacityDomain);
        string applicationKey = _coordinator.Topology.CapacityIdentity(DiskDomain);
        string inodeCapacityKey = _coordinator.Topology.CapacityIdentity(_inodeCapacityDomain);
        string inodeKey = _coordinator.Topology.CapacityIdentity(InodeDomain);
        return snapshot.PolicyRevision == sample.PolicyRevision && !snapshot.Faulted
            && (!diskGrowth || (snapshot.HardCaps.TryGetValue(capacityKey, out long cap) && cap <= capacityCap
                && snapshot.HardCaps.TryGetValue(applicationKey, out long applicationCap) && applicationCap <= _applicationCapBytes))
            && (!inodeGrowth || (snapshot.HardCaps.TryGetValue(inodeCapacityKey, out long inodeCap)
                && inodeCap <= sample.AvailableInodes.Value!.Value
                && snapshot.HardCaps.TryGetValue(inodeKey, out long applicationInodes)
                && applicationInodes <= sample.AvailableInodes.Value!.Value));
    }

    private static bool Usable(MemoryResourceObservation observation, DateTimeOffset now, ResourceDomainId domain)
        => observation.Domain == domain && observation.State == MemoryObservationState.Available
            && observation.SampledAt <= now;
}
