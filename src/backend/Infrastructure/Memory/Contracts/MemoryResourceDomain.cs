namespace FsusBlog.Server.Infrastructure.Memory.Contracts;

public readonly record struct ResourceDomainId(Guid Value);
public enum MemoryResourceUnit
{
    Bytes, OperationSlots
}
public enum MemoryObservationState
{
    Unknown, Available, Denied, Malformed, Stale
}

public sealed record MemoryResourceDomain(
    ResourceDomainId Id,
    string CapacityIdentity,
    MemoryResourceUnit Unit,
    ResourceDomainId? ContainingDomain);

// PROVENANCE: Unknown/denied/stale samples carry no fabricated numeric availability.
public sealed class MemoryResourceObservation
{
    public MemoryResourceObservation(ResourceDomainId domain, MemoryResourceUnit unit,
        MemoryObservationState state, long? value, string source, DateTimeOffset sampledAt)
    {
        if (domain.Value == Guid.Empty || !Enum.IsDefined(unit) || !Enum.IsDefined(state)
            || (state == MemoryObservationState.Available ? value is null or < 0 : value is not null)
            || string.IsNullOrWhiteSpace(source))
        {
            throw new ArgumentException("Invalid resource observation or missing provenance.");
        }
        Domain = domain;
        Unit = unit;
        State = state;
        Value = value;
        Source = source;
        SampledAt = sampledAt;
    }

    public ResourceDomainId Domain
    {
        get;
    }
    public MemoryResourceUnit Unit
    {
        get;
    }
    public MemoryObservationState State
    {
        get;
    }
    public long? Value
    {
        get;
    }
    public string Source
    {
        get;
    }
    public DateTimeOffset SampledAt
    {
        get;
    }
}

public sealed class MemoryResourceTopology
{
    private readonly Dictionary<ResourceDomainId, MemoryResourceDomain> _domains;

    public MemoryResourceTopology(IEnumerable<MemoryResourceDomain> domains)
    {
        ArgumentNullException.ThrowIfNull(domains);
        _domains = domains.ToDictionary(domain => domain.Id);
        foreach (MemoryResourceDomain domain in _domains.Values)
        {
            if (domain.Id.Value == Guid.Empty || string.IsNullOrWhiteSpace(domain.CapacityIdentity) || !Enum.IsDefined(domain.Unit))
            {
                throw new ArgumentException("A domain requires an identity and explicit unit.", nameof(domains));
            }
            var visited = new HashSet<ResourceDomainId> { domain.Id };
            MemoryResourceDomain cursor = domain;
            while (cursor.ContainingDomain is ResourceDomainId parentId)
            {
                if (!_domains.TryGetValue(parentId, out MemoryResourceDomain? parent)
                    || parent.Unit != domain.Unit || !visited.Add(parentId))
                {
                    throw new ArgumentException("Missing, cyclic or unit-incompatible containment.", nameof(domains));
                }
                cursor = parent;
            }
        }
        if (_domains.Values.GroupBy(domain => domain.CapacityIdentity, StringComparer.Ordinal)
            .Any(group => group.Select(domain => domain.Unit).Distinct().Count() != 1))
        {
            throw new ArgumentException("Capacity aliases must use the same unit.", nameof(domains));
        }
    }

    public int DomainCount => _domains.Count;
    public MemoryResourceUnit Unit(ResourceDomainId id) => _domains[id].Unit;

    public IEnumerable<MemoryResourceDomain> ConstraintChain(ResourceDomainId id)
    {
        MemoryResourceDomain current = _domains[id];
        while (true)
        {
            yield return current;
            if (current.ContainingDomain is not ResourceDomainId parent)
            {
                yield break;
            }
            current = _domains[parent];
        }
    }

    public string CapacityIdentity(ResourceDomainId id) => _domains[id].CapacityIdentity;

    public bool SharesCapacityOrContainment(ResourceDomainId left, ResourceDomainId right)
    {
        MemoryResourceDomain first = _domains[left];
        MemoryResourceDomain second = _domains[right];
        return first.CapacityIdentity == second.CapacityIdentity || Contains(first, right) || Contains(second, left);
    }

    private bool Contains(MemoryResourceDomain child, ResourceDomainId possibleParent)
    {
        while (child.ContainingDomain is ResourceDomainId parentId)
        {
            if (parentId == possibleParent)
            {
                return true;
            }
            child = _domains[parentId];
        }
        return false;
    }
}
