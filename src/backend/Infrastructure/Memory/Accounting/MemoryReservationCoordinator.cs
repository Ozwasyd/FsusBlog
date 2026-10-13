using System.Collections.ObjectModel;

using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Accounting;

public sealed record MemoryResourceLimit(ResourceDomainId Domain, MemoryResourceUnit Unit, long HardCap);
public sealed record MemoryAccountingEvent(ulong Sequence, string Kind, Guid Reservation, AllocationId? Allocation, IReadOnlyDictionary<string, long> Delta);
public sealed record MemoryAccountingSnapshot(ulong PolicyRevision, int Reservations, int Allocations,
    bool Faulted, bool OverTarget, IReadOnlyDictionary<string, long> Used, IReadOnlyDictionary<string, long> HardCaps)
{
    public IReadOnlyDictionary<string, long> EnforcedHardCaps
    {
        get; internal init;
    } = HardCaps;
}
public sealed record MemoryAccountingEventWindow(bool CompleteFromStart, IReadOnlyList<MemoryAccountingEvent> Events);
public sealed record MemoryAllocationObservation(AllocationId Allocation, MemoryAllocationDescriptor? Descriptor,
    IReadOnlyList<MemoryResourceCharge> ActualCharges);

// LINEARIZATION: One gate admits the complete vector, converts its ownership or releases
// its charge. No allocator, callback, await, I/O or external sampler runs under this gate.
public sealed class MemoryReservationCoordinator
{
    private readonly object _gate = new();
    private readonly MemoryResourceTopology _topology;
    private readonly int _entryLimit;
    private readonly MemoryAccountingEvent?[] _events;
    private readonly HashSet<ResourceDomainId> _existingPhysicalDomains;
    private Dictionary<string, long> _used = new(StringComparer.Ordinal);
    private readonly HashSet<MemoryReservation> _reservations = [];
    private readonly Dictionary<AllocationId, MemoryAllocationCharge> _allocations = [];
    private Dictionary<string, long> _caps;
    private ulong _policyRevision;
    private ulong _governedSequence;
    private Dictionary<string, long> _governedCaps = new(StringComparer.Ordinal);
    private ulong _sequence;
    private bool _faulted;

    internal MemoryResourceTopology Topology => _topology;

    public MemoryReservationCoordinator(MemoryResourceTopology topology, IEnumerable<MemoryResourceLimit> limits,
        ulong policyRevision, int entryLimit, int eventCapacity,
        IEnumerable<ResourceDomainId>? existingPhysicalDomains = null)
    {
        ArgumentNullException.ThrowIfNull(topology);
        if (policyRevision == 0 || entryLimit <= 0 || eventCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(policyRevision), "Revision and bounded metadata limits must be positive.");
        }
        _topology = topology;
        ResourceDomainId[] persistent = existingPhysicalDomains?.Take(topology.DomainCount + 1).ToArray() ?? [];
        _existingPhysicalDomains = new HashSet<ResourceDomainId>(persistent);
        if (persistent.Length > topology.DomainCount || persistent.Length != _existingPhysicalDomains.Count
            || persistent.Any(domain => topology.Unit(domain) is not (MemoryResourceUnit.Bytes or MemoryResourceUnit.Inodes)))
        {
            throw new ArgumentException("Existing ownership requires distinct registered physical byte/inode domains.", nameof(existingPhysicalDomains));
        }
        _entryLimit = entryLimit;
        _caps = NormalizeLimits(limits);
        _events = new MemoryAccountingEvent[eventCapacity];
        _policyRevision = policyRevision;
        foreach (string key in _caps.Keys)
        {
            _used.Add(key, 0);
        }
    }

    public MemoryOperationResult<MemoryReservation> TryReserve(IEnumerable<MemoryResourceCharge> requested)
        => Reserve(requested, null, null);

    public MemoryOperationResult<MemoryReservation> TryReserveUnderBounds(IEnumerable<MemoryResourceCharge> requested,
        IReadOnlyDictionary<string, long> additionalHardCaps, ulong observedPolicyRevision)
    {
        ArgumentNullException.ThrowIfNull(additionalHardCaps);
        var bounds = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach ((string key, long value) in additionalHardCaps.Take(_topology.DomainCount + 1))
        {
            if (bounds.Count == _topology.DomainCount || string.IsNullOrWhiteSpace(key) || value < 0 || !bounds.TryAdd(key, value))
            {
                return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BoundsViolation);
            }
        }
        return Reserve(requested, bounds, observedPolicyRevision);
    }

    private MemoryOperationResult<MemoryReservation> Reserve(IEnumerable<MemoryResourceCharge> requested,
        IReadOnlyDictionary<string, long>? additionalHardCaps, ulong? observedPolicyRevision)
    {
        IReadOnlyList<MemoryResourceCharge> held = Freeze(requested);
        Dictionary<string, long>? vector;
        try
        {
            vector = NormalizeCharges(held);
        }
        catch (KeyNotFoundException)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.TierUnavailable);
        }
        if (vector is null)
        {
            return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BoundsViolation);
        }
        lock (_gate)
        {
            if (_faulted)
            {
                return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (observedPolicyRevision is not null && observedPolicyRevision != _policyRevision)
            {
                return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.StaleLocation);
            }
            if (additionalHardCaps is not null && (additionalHardCaps.Keys.Any(key => !_caps.ContainsKey(key))
                || vector.Keys.Any(key => !additionalHardCaps.ContainsKey(key))))
            {
                return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.TierUnavailable);
            }
            if (_reservations.Count + _allocations.Count >= _entryLimit || !Fits(vector)
                || additionalHardCaps is not null && vector.Any(entry => entry.Value > additionalHardCaps[entry.Key]
                    || _used.GetValueOrDefault(entry.Key) > additionalHardCaps[entry.Key] - entry.Value))
            {
                return MemoryOperationResult<MemoryReservation>.Reject(MemoryFailure.BudgetRejected);
            }
            EnsureEventSpace();
            var reservation = new MemoryReservation(this, held, vector);
            MemoryAccountingEvent next = PrepareEvent("reserved", vector, reservation.TokenId, null);
            _reservations.Add(reservation);
            Apply(vector);
            Record(next);
            return MemoryOperationResult<MemoryReservation>.Success(reservation);
        }
    }

    public MemoryFailure? ApplyGovernedBounds(ulong decisionSequence, ulong observedPolicyRevision,
        IReadOnlyDictionary<string, long> bounds)
    {
        ArgumentNullException.ThrowIfNull(bounds);
        var next = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach ((string key, long value) in bounds.Take(_topology.DomainCount + 1))
        {
            if (next.Count == _topology.DomainCount || string.IsNullOrWhiteSpace(key) || value < 0 || !next.TryAdd(key, value))
            {
                return MemoryFailure.BoundsViolation;
            }
        }
        lock (_gate)
        {
            if (_faulted)
            {
                return MemoryFailure.OwnershipViolation;
            }
            if (observedPolicyRevision != _policyRevision || decisionSequence == 0 || decisionSequence < _governedSequence)
            {
                return MemoryFailure.StaleLocation;
            }
            if (next.Count == 0 || next.Keys.Any(key => !_caps.ContainsKey(key))
                || _governedCaps.Keys.Any(key => !next.ContainsKey(key)))
            {
                return MemoryFailure.TierUnavailable;
            }
            if (decisionSequence == _governedSequence)
            {
                return next.Count == _governedCaps.Count && next.All(item => _governedCaps.GetValueOrDefault(item.Key, -1) == item.Value)
                    ? null : MemoryFailure.StaleLocation;
            }
            _governedCaps = next;
            _governedSequence = decisionSequence;
            return null;
        }
    }

    public void ReviseLimits(ulong revision, IEnumerable<MemoryResourceLimit> limits)
    {
        Dictionary<string, long> next = NormalizeLimits(limits);
        lock (_gate)
        {
            if (revision <= _policyRevision)
            {
                throw new ArgumentOutOfRangeException(nameof(revision), "Policy revision must advance.");
            }
            // ACCOUNTING: Removing a limit disables new growth; old tokens and usage survive.
            foreach (string key in _used.Keys)
            {
                next.TryAdd(key, 0);
            }
            var used = new Dictionary<string, long>(_used, StringComparer.Ordinal);
            foreach (string key in next.Keys)
            {
                used.TryAdd(key, 0);
            }
            _used = used;
            _caps = next;
            _policyRevision = revision;
            _governedSequence = 0;
        }
    }

    public MemoryAccountingSnapshot Snapshot()
    {
        lock (_gate)
        {
            return new(_policyRevision, _reservations.Count, _allocations.Count, _faulted,
                _used.Any(entry => entry.Value > Math.Min(_caps[entry.Key], _governedCaps.GetValueOrDefault(entry.Key, long.MaxValue))), ReadOnly(_used), ReadOnly(_caps))
            {
                EnforcedHardCaps = ReadOnly(_caps.ToDictionary(item => item.Key,
                    item => Math.Min(item.Value, _governedCaps.GetValueOrDefault(item.Key, long.MaxValue)), StringComparer.Ordinal))
            };
        }
    }

    public MemoryAccountingEventWindow EventWindow()
    {
        lock (_gate)
        {
            ulong first = _sequence > (ulong)_events.Length ? _sequence - (ulong)_events.Length + 1 : 1;
            var events = new List<MemoryAccountingEvent>(_events.Length);
            int count = (int)Math.Min(_sequence, (ulong)_events.Length);
            for (int index = 0; index < count; index++)
            {
                events.Add(_events[(int)((first + (ulong)index - 1) % (ulong)_events.Length)]!);
            }
            return new(_sequence <= (ulong)_events.Length, events.AsReadOnly());
        }
    }

    public IReadOnlyList<MemoryAllocationObservation> Allocations()
    {
        lock (_gate)
        {
            // Metadata is bounded by the existing entry limit. Unknown layouts stay
            // explicit; operation-slot charges cannot masquerade as physical bytes.
            return Array.AsReadOnly(_allocations.Values.Select(charge =>
                new MemoryAllocationObservation(charge.Allocation, charge.Descriptor, charge.ActualCharges)).ToArray());
        }
    }

    internal MemoryOperationResult<IMemoryAllocationCharge> Commit(MemoryReservation reservation,
        AllocationId allocation, IReadOnlyList<MemoryResourceCharge> charges, MemoryAllocationDescriptor? descriptor = null)
    {
        IReadOnlyList<MemoryResourceCharge> actual = Freeze(charges);
        Dictionary<string, long>? vector;
        try
        {
            vector = NormalizeCharges(actual);
        }
        catch (KeyNotFoundException)
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.TierUnavailable);
        }
        if (allocation.Value == Guid.Empty || vector is null)
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BoundsViolation);
        }
        if (descriptor is not null && (descriptor.Allocation != allocation
            || !actual.Any(charge => charge.Domain == descriptor.Domain && charge.Unit == MemoryResourceUnit.Bytes
                && charge.Amount == descriptor.Layout.CapacityBytes)))
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BoundsViolation);
        }
        lock (_gate)
        {
            if (_faulted || reservation.State != 0 || !_reservations.Contains(reservation))
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (_allocations.ContainsKey(allocation))
            {
                _faulted = true;
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
            }
            // ADMISSION: Expanded/rounded backing must be admitted before the allocator call.
            // This conversion rejects an excess instead of silently charging it afterward.
            if (vector.Any(entry => !reservation.Vector.TryGetValue(entry.Key, out long admitted) || entry.Value > admitted))
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BudgetRejected);
            }
            EnsureEventSpace();
            Dictionary<string, long> delta = reservation.Vector.ToDictionary(entry => entry.Key,
                entry => vector.GetValueOrDefault(entry.Key) - entry.Value, StringComparer.Ordinal);
            var charge = new MemoryAllocationCharge(this, allocation, actual, vector, reservation.TokenId, descriptor);
            MemoryAccountingEvent next = PrepareEvent("committed", delta, reservation.TokenId, allocation);
            _allocations.Add(allocation, charge);
            _reservations.Remove(reservation);
            reservation.State = 1;
            Apply(delta);
            Record(next);
            return MemoryOperationResult<IMemoryAllocationCharge>.Success(charge);
        }
    }

    // ACCOUNTING: Observe pre-existing ownership, never grant permission to create backing.
    // The persistent storage owner verifies object identity and holds it through adoption.
    // New host/index resources still require this reservation; live over-cap bytes remain visible.
    internal MemoryOperationResult<IMemoryAllocationCharge> CommitObservedExisting(MemoryReservation reservation,
        MemoryAllocationDescriptor descriptor, IReadOnlyList<MemoryResourceCharge> existingCharges,
        IReadOnlyList<MemoryResourceCharge> newlyAdmittedCharges, ulong observedPolicyRevision)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        IReadOnlyList<MemoryResourceCharge> existing = Freeze(existingCharges);
        IReadOnlyList<MemoryResourceCharge> newlyAdmitted = Freeze(newlyAdmittedCharges);
        Dictionary<string, long>? existingVector;
        Dictionary<string, long>? newVector;
        try
        {
            existingVector = NormalizeCharges(existing);
            newVector = newlyAdmitted.Count == 0 ? new(StringComparer.Ordinal) : NormalizeCharges(newlyAdmitted);
        }
        catch (KeyNotFoundException)
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.TierUnavailable);
        }
        if (existingVector is null || newVector is null || observedPolicyRevision == 0
            || !existing.Any(charge => charge.Domain == descriptor.Domain && charge.Unit == MemoryResourceUnit.Bytes
                && charge.Amount == descriptor.Layout.CapacityBytes))
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BoundsViolation);
        }
        if (existing.Any(charge => !_existingPhysicalDomains.Contains(charge.Domain))
            || newlyAdmitted.Any(charge => _existingPhysicalDomains.Contains(charge.Domain))
            || existingVector.Keys.Intersect(newVector.Keys, StringComparer.Ordinal).Any())
        {
            return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
        }
        IReadOnlyList<MemoryResourceCharge> actual = Freeze(existing.Concat(newlyAdmitted));
        lock (_gate)
        {
            if (_faulted || reservation.State != 0 || !_reservations.Contains(reservation)
                || observedPolicyRevision != _policyRevision)
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (_allocations.ContainsKey(descriptor.Allocation))
            {
                _faulted = true;
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
            }
            if (existingVector.Keys.Any(key => !_caps.ContainsKey(key)))
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.TierUnavailable);
            }
            if (newVector.Any(entry => !reservation.Vector.TryGetValue(entry.Key, out long admitted) || entry.Value > admitted))
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BudgetRejected);
            }
            var vector = new Dictionary<string, long>(existingVector, StringComparer.Ordinal);
            foreach ((string key, long amount) in newVector)
            {
                vector.Add(key, amount);
            }
            var delta = new Dictionary<string, long>(vector, StringComparer.Ordinal);
            foreach ((string key, long amount) in reservation.Vector)
            {
                delta[key] = delta.GetValueOrDefault(key) - amount;
            }
            try
            {
                foreach ((string key, long amount) in delta)
                {
                    if (checked(_used.GetValueOrDefault(key) + amount) < 0)
                    {
                        return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.OwnershipViolation);
                    }
                }
            }
            catch (OverflowException)
            {
                return MemoryOperationResult<IMemoryAllocationCharge>.Reject(MemoryFailure.BoundsViolation);
            }
            EnsureEventSpace();
            var charge = new MemoryAllocationCharge(this, descriptor.Allocation, actual, vector, reservation.TokenId, descriptor);
            MemoryAccountingEvent next = PrepareEvent("existing-registered", delta, reservation.TokenId, descriptor.Allocation);
            _allocations.Add(descriptor.Allocation, charge);
            _reservations.Remove(reservation);
            reservation.State = 1;
            Apply(delta);
            Record(next);
            return MemoryOperationResult<IMemoryAllocationCharge>.Success(charge);
        }
    }

    internal void Release(MemoryReservation reservation)
    {
        lock (_gate)
        {
            if (reservation.State != 0)
            {
                return;
            }
            if (!_reservations.Contains(reservation))
            {
                _faulted = true;
                throw new InvalidOperationException("Reservation owner mismatch.");
            }
            EnsureEventSpace();
            Dictionary<string, long> delta = Negate(reservation.Vector);
            MemoryAccountingEvent next = PrepareEvent("reservation-released", delta, reservation.TokenId, null);
            Apply(delta);
            _reservations.Remove(reservation);
            reservation.State = 2;
            Record(next);
        }
    }

    internal void Release(MemoryAllocationCharge charge)
    {
        lock (_gate)
        {
            if (charge.Released)
            {
                return;
            }
            if (!_allocations.TryGetValue(charge.Allocation, out MemoryAllocationCharge? current) || !ReferenceEquals(current, charge))
            {
                _faulted = true;
                throw new InvalidOperationException("Allocation owner mismatch.");
            }
            EnsureEventSpace();
            Dictionary<string, long> delta = Negate(charge.Vector);
            MemoryAccountingEvent next = PrepareEvent("allocation-released", delta, charge.ReservationId, charge.Allocation);
            Apply(delta);
            _allocations.Remove(charge.Allocation);
            charge.Released = true;
            Record(next);
        }
    }

    private Dictionary<string, long> NormalizeLimits(IEnumerable<MemoryResourceLimit> limits)
    {
        ArgumentNullException.ThrowIfNull(limits);
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        var seen = new HashSet<ResourceDomainId>();
        foreach (MemoryResourceLimit limit in limits)
        {
            if (limit.HardCap < 0 || !seen.Add(limit.Domain) || _topology.Unit(limit.Domain) != limit.Unit)
            {
                throw new ArgumentException("Limits require unique known domains, matching units and finite nonnegative caps.", nameof(limits));
            }
            string key = _topology.CapacityIdentity(limit.Domain);
            result[key] = Math.Min(result.GetValueOrDefault(key, long.MaxValue), limit.HardCap);
        }
        if (result.Count == 0)
        {
            throw new ArgumentException("At least one finite hard limit is required.", nameof(limits));
        }
        return result;
    }

    private Dictionary<string, long>? NormalizeCharges(IReadOnlyList<MemoryResourceCharge> charges)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        var seen = new HashSet<ResourceDomainId>();
        foreach (MemoryResourceCharge charge in charges)
        {
            if (charge.Amount <= 0 || !seen.Add(charge.Domain) || _topology.Unit(charge.Domain) != charge.Unit)
            {
                return null;
            }
            // CONTAINMENT: A subset also spends every containing capacity. Explicitly
            // repeating a parent or alias never creates a second physical charge.
            foreach (MemoryResourceDomain domain in _topology.ConstraintChain(charge.Domain))
            {
                string key = domain.CapacityIdentity;
                result[key] = Math.Max(result.GetValueOrDefault(key), charge.Amount);
            }
        }
        return result.Count == 0 ? null : result;
    }

    private bool Fits(Dictionary<string, long> vector)
        => vector.All(entry => _caps.TryGetValue(entry.Key, out long cap)
            && entry.Value <= Math.Min(cap, _governedCaps.GetValueOrDefault(entry.Key, long.MaxValue))
            && _used.GetValueOrDefault(entry.Key) <= Math.Min(cap, _governedCaps.GetValueOrDefault(entry.Key, long.MaxValue)) - entry.Value);

    private void Apply(Dictionary<string, long> delta)
    {
        foreach ((string key, long change) in delta)
        {
            _used[key] = checked(_used[key] + change);
        }
    }

    private void EnsureEventSpace()
    {
        if (_sequence == ulong.MaxValue)
        {
            _faulted = true;
            throw new InvalidOperationException("Accounting event sequence exhausted.");
        }
    }

    private MemoryAccountingEvent PrepareEvent(string kind, Dictionary<string, long> delta, Guid reservation, AllocationId? allocation)
        => new(_sequence + 1, kind, reservation, allocation, ReadOnly(delta));

    private void Record(MemoryAccountingEvent next)
    {
        _sequence = next.Sequence;
        _events[(int)((_sequence - 1) % (ulong)_events.Length)] = next;
    }

    private static IReadOnlyDictionary<string, long> ReadOnly(Dictionary<string, long> values)
        => new ReadOnlyDictionary<string, long>(new Dictionary<string, long>(values, StringComparer.Ordinal));
    private static Dictionary<string, long> Negate(Dictionary<string, long> vector)
        => vector.ToDictionary(entry => entry.Key, entry => -entry.Value, StringComparer.Ordinal);
    private IReadOnlyList<MemoryResourceCharge> Freeze(IEnumerable<MemoryResourceCharge> charges)
    {
        ArgumentNullException.ThrowIfNull(charges);
        MemoryResourceCharge[] held = charges.Take(_topology.DomainCount + 1).ToArray();
        if (held.Length > _topology.DomainCount)
        {
            throw new ArgumentException("Resource vector exceeds the finite domain roster.", nameof(charges));
        }
        return Array.AsReadOnly(held);
    }
}

public sealed class MemoryReservation : IMemoryReservation
{
    private readonly MemoryReservationCoordinator _coordinator;
    internal MemoryReservation(MemoryReservationCoordinator coordinator,
        IReadOnlyList<MemoryResourceCharge> reserved, Dictionary<string, long> vector)
    {
        _coordinator = coordinator;
        Reserved = reserved;
        Vector = vector;
    }
    internal Guid TokenId { get; } = Guid.NewGuid();
    internal int State
    {
        get; set;
    }
    internal Dictionary<string, long> Vector
    {
        get;
    }
    public IReadOnlyList<MemoryResourceCharge> Reserved
    {
        get;
    }
    public MemoryOperationResult<IMemoryAllocationCharge> Commit(AllocationId allocation, IReadOnlyList<MemoryResourceCharge> actualCharges)
        => _coordinator.Commit(this, allocation, actualCharges);
    public MemoryOperationResult<IMemoryAllocationCharge> CommitPhysical(MemoryAllocationDescriptor descriptor, IReadOnlyList<MemoryResourceCharge> actualCharges)
    {
        ArgumentNullException.ThrowIfNull(descriptor);
        return _coordinator.Commit(this, descriptor.Allocation, actualCharges, descriptor);
    }
    /// <summary>
    /// Adopt storage-owner-verified existing backing in registered persistent domains.
    /// Does not allocate, qualify content, or authorize file creation. The owner must
    /// reject replaced objects before calling and release only after actual deletion.
    /// </summary>
    public MemoryOperationResult<IMemoryAllocationCharge> CommitObservedExisting(MemoryAllocationDescriptor descriptor,
        IReadOnlyList<MemoryResourceCharge> observedExistingPhysicalCharges,
        IReadOnlyList<MemoryResourceCharge> newlyAdmittedCharges, ulong observedPolicyRevision)
        => _coordinator.CommitObservedExisting(this, descriptor, observedExistingPhysicalCharges,
            newlyAdmittedCharges, observedPolicyRevision);
    public void Dispose() => _coordinator.Release(this);
}

internal sealed class MemoryAllocationCharge : IMemoryAllocationCharge
{
    private readonly MemoryReservationCoordinator _coordinator;
    internal MemoryAllocationCharge(MemoryReservationCoordinator coordinator, AllocationId allocation,
        IReadOnlyList<MemoryResourceCharge> actual, Dictionary<string, long> vector, Guid reservationId,
        MemoryAllocationDescriptor? descriptor)
    {
        _coordinator = coordinator;
        Allocation = allocation;
        Descriptor = descriptor;
        ActualCharges = actual;
        ReservationId = reservationId;
        Vector = vector;
    }
    internal Guid ReservationId
    {
        get;
    }
    internal bool Released
    {
        get; set;
    }
    internal Dictionary<string, long> Vector
    {
        get;
    }
    public AllocationId Allocation
    {
        get;
    }
    public MemoryAllocationDescriptor? Descriptor
    {
        get;
    }
    public IReadOnlyList<MemoryResourceCharge> ActualCharges
    {
        get;
    }
    public void Dispose() => _coordinator.Release(this);
}
