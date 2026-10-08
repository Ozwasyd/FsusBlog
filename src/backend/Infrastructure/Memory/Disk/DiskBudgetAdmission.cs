using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Disk;

/// <summary>A complete disk/host/slot request; zero disk bytes represents read or recovery scratch.</summary>
public sealed record DiskBudgetRequest(long DiskBytes, long HostBytes, long OperationSlots);

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
    private readonly Func<DiskCapacityObservation> _observe;
    private readonly TimeProvider _timeProvider;
    private readonly long _safetyReserveBytes;
    private readonly long _applicationCapBytes;

    public DiskBudgetAdmission(MemoryReservationCoordinator coordinator, ResourceDomainId diskDomain,
        ResourceDomainId capacityDomain, ResourceDomainId hostDomain, ResourceDomainId slotDomain,
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
            || !coordinator.Topology.ConstraintChain(diskDomain).Any(domain => domain.Id == capacityDomain)
            || coordinator.Topology.ConstraintChain(diskDomain).Select(domain => domain.CapacityIdentity)
                .Intersect(coordinator.Topology.ConstraintChain(hostDomain).Select(domain => domain.CapacityIdentity),
                    StringComparer.Ordinal).Any())
        {
            throw new ArgumentException("Disk admission requires independent host and slot domains and a containing shared volume.");
        }
        _coordinator = coordinator;
        _capacityDomain = capacityDomain;
        _observe = observe;
        _timeProvider = timeProvider ?? TimeProvider.System;
        _safetyReserveBytes = safetyReserveBytes;
        _applicationCapBytes = applicationCapBytes;
        DiskDomain = diskDomain;
        HostDomain = hostDomain;
        SlotDomain = slotDomain;
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

    public MemoryOperationResult<MemoryReservation> TryReserve(DiskBudgetRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.DiskBytes < 0 || request.HostBytes <= 0 || request.OperationSlots <= 0)
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
            || !Usable(sample.AvailableInodes, now, SlotDomain)
            || sample.AvailableBytes.Unit != MemoryResourceUnit.Bytes
            || sample.QuotaBytes.Unit != MemoryResourceUnit.Bytes
            || sample.AvailableInodes.Unit != MemoryResourceUnit.OperationSlots)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.TierUnavailable);
        }
        long headroom = Math.Min(sample.AvailableBytes.Value!.Value, sample.QuotaBytes.Value!.Value);
        if (headroom < _safetyReserveBytes || sample.AvailableInodes.Value!.Value < request.OperationSlots)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
        }
        long capacityCap = headroom - _safetyReserveBytes;
        if (!CapsBoundToSample(_coordinator.Snapshot(), sample, capacityCap))
        {
            // A new lower free-space sample is not an exclusive grant. The common policy
            // owner must reduce its shared cap; existing charges remain until actual deletion.
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
        }
        var vector = new List<MemoryResourceCharge>(3)
        {
            new(HostDomain, MemoryResourceUnit.Bytes, request.HostBytes),
            new(SlotDomain, MemoryResourceUnit.OperationSlots, request.OperationSlots)
        };
        if (request.DiskBytes > 0)
        {
            vector.Add(new(DiskDomain, MemoryResourceUnit.Bytes, request.DiskBytes));
        }
        MemoryOperationResult<MemoryReservation> result = _coordinator.TryReserve(vector);
        if (!result.Succeeded)
        {
            return result;
        }
        // Bind against concurrent owner policy changes without touching the owner's limits.
        // Failed revalidation releases this token only; live allocations are never fabricated away.
        if (!CapsBoundToSample(_coordinator.Snapshot(), sample, capacityCap))
        {
            result.Value!.Dispose();
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
        }
        return result;
    }

    private bool CapsBoundToSample(MemoryAccountingSnapshot snapshot, DiskCapacityObservation sample, long capacityCap)
    {
        string capacityKey = _coordinator.Topology.CapacityIdentity(_capacityDomain);
        string applicationKey = _coordinator.Topology.CapacityIdentity(DiskDomain);
        string slotKey = _coordinator.Topology.CapacityIdentity(SlotDomain);
        return snapshot.PolicyRevision == sample.PolicyRevision && !snapshot.Faulted
            && snapshot.HardCaps.TryGetValue(capacityKey, out long cap) && cap <= capacityCap
            && snapshot.HardCaps.TryGetValue(applicationKey, out long applicationCap) && applicationCap <= _applicationCapBytes
            && snapshot.HardCaps.TryGetValue(slotKey, out long slots) && slots <= sample.AvailableInodes.Value!.Value;
    }

    private static bool Usable(MemoryResourceObservation observation, DateTimeOffset now, ResourceDomainId domain)
        => observation.Domain == domain && observation.State == MemoryObservationState.Available
            && observation.SampledAt <= now;
}
