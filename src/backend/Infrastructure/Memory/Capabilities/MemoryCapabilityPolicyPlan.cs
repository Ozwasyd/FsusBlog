using System.Collections.ObjectModel;

namespace FsusBlog.Server.Infrastructure.Memory.Capabilities;

public sealed record MemoryCapabilityRegistration(string Id, IReadOnlyList<string> Dependencies,
    string? ExclusiveGroup, int SelectionPriority);
public sealed record MemoryCapabilityWorkloadAdmission(ulong PolicyRevision,
    MemoryQualification Qualification, MemoryAdmission Admission);

/// <summary>
/// A bounded immutable plan consumed by the existing configuration and capability owners.
/// Construction validates the whole revision before any side effects. This plan neither
/// probes resources nor certifies the qualification facts supplied by a controller.
/// </summary>
public sealed class MemoryCapabilityPolicyPlan
{
    private readonly IReadOnlyDictionary<string, MemoryCapabilityRegistration> _registrations;
    private readonly IReadOnlyList<MemoryCapabilityRegistration> _ordered;
    private readonly MemoryCapabilityPolicyRevision _policy;

    public MemoryCapabilityPolicyPlan(ulong revision, IEnumerable<MemoryCapabilityRegistration> registrations,
        IReadOnlyDictionary<string, MemoryCapabilityMode> requested, int maximumCapabilities)
    {
        ArgumentNullException.ThrowIfNull(registrations);
        ArgumentNullException.ThrowIfNull(requested);
        if (maximumCapabilities is <= 0 or > 4096 || revision == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumCapabilities));
        }
        var roster = new Dictionary<string, MemoryCapabilityRegistration>(StringComparer.Ordinal);
        foreach (MemoryCapabilityRegistration registration in registrations.Take(maximumCapabilities + 1))
        {
            ArgumentNullException.ThrowIfNull(registration);
            ArgumentNullException.ThrowIfNull(registration.Dependencies);
            if (roster.Count == maximumCapabilities || !ValidId(registration.Id)
                || registration.ExclusiveGroup is not null && !ValidId(registration.ExclusiveGroup)
                || registration.SelectionPriority < 0)
            {
                throw new ArgumentException("Invalid or oversized capability roster.", nameof(registrations));
            }
            string[] dependencies = registration.Dependencies.Take(maximumCapabilities + 1).ToArray();
            if (dependencies.Length > maximumCapabilities || dependencies.Any(id => !ValidId(id))
                || dependencies.Distinct(StringComparer.Ordinal).Count() != dependencies.Length)
            {
                throw new ArgumentException("Invalid or oversized dependency roster.", nameof(registrations));
            }
            roster.Add(registration.Id, registration with
            {
                Dependencies = Array.AsReadOnly(dependencies)
            });
        }
        if (roster.Count == 0 || requested.Count > roster.Count || requested.Keys.Any(id => !roster.ContainsKey(id)))
        {
            throw new ArgumentException("Every setting must name a registered capability.", nameof(requested));
        }
        var normalized = new Dictionary<string, MemoryCapabilityMode>(StringComparer.Ordinal);
        foreach (string id in roster.Keys.Order(StringComparer.Ordinal))
        {
            normalized.Add(id, MemoryCapabilityPolicy.Validate(requested.GetValueOrDefault(id, MemoryCapabilityMode.Auto)));
        }
        _policy = new MemoryCapabilityPolicyRevision(revision, normalized);
        var remaining = roster.ToDictionary(item => item.Key, item => item.Value.Dependencies.Count, StringComparer.Ordinal);
        var dependents = roster.Keys.ToDictionary(id => id, _ => new List<string>(), StringComparer.Ordinal);
        foreach (MemoryCapabilityRegistration registration in roster.Values)
        {
            foreach (string parent in registration.Dependencies)
            {
                if (!dependents.TryGetValue(parent, out List<string>? children))
                {
                    throw new ArgumentException("A dependency is not registered.", nameof(registrations));
                }
                children.Add(registration.Id);
            }
        }
        var ready = new SortedSet<string>(remaining.Where(item => item.Value == 0).Select(item => item.Key), StringComparer.Ordinal);
        var ordered = new List<MemoryCapabilityRegistration>(roster.Count);
        var blocked = new Dictionary<string, bool>(StringComparer.Ordinal);
        while (ready.Count > 0)
        {
            string id = ready.Min!;
            ready.Remove(id);
            MemoryCapabilityRegistration registration = roster[id];
            bool disabledDependency = registration.Dependencies.Any(parent => blocked[parent]);
            if (_policy.Requested(id) == MemoryCapabilityMode.Required && disabledDependency)
            {
                throw new ArgumentException("Required capability has a Disabled dependency.", nameof(requested));
            }
            blocked.Add(id, disabledDependency || _policy.Requested(id) == MemoryCapabilityMode.Disabled);
            ordered.Add(registration);
            foreach (string child in dependents[id])
            {
                if (--remaining[child] == 0)
                {
                    ready.Add(child);
                }
            }
        }
        if (ordered.Count != roster.Count)
        {
            throw new ArgumentException("Capability dependencies contain a cycle.", nameof(registrations));
        }
        if (roster.Values.Where(item => item.ExclusiveGroup is not null)
            .GroupBy(item => item.ExclusiveGroup, StringComparer.Ordinal)
            .Any(group => group.Count(item => _policy.Requested(item.Id) == MemoryCapabilityMode.Required) > 1))
        {
            throw new ArgumentException("An exclusive group cannot require competing backends.", nameof(requested));
        }
        _registrations = new ReadOnlyDictionary<string, MemoryCapabilityRegistration>(roster);
        _ordered = ordered.AsReadOnly();
    }

    public ulong Revision => _policy.Revision;
    public IReadOnlyList<MemoryCapabilityRegistration> DependencyOrder => _ordered;

    public MemoryCapabilityMode Requested(string id)
        => _registrations.ContainsKey(id) ? _policy.Requested(id)
            : throw new ArgumentException("Capability is not registered.", nameof(id));

    public string? SelectQualifiedBackend(string exclusiveGroup,
        IReadOnlyDictionary<string, MemoryCapabilityStatus> statuses,
        IReadOnlyDictionary<string, MemoryCapabilityWorkloadAdmission> admissions)
    {
        ArgumentNullException.ThrowIfNull(statuses);
        ArgumentNullException.ThrowIfNull(admissions);
        if (!ValidId(exclusiveGroup))
        {
            throw new ArgumentException("Invalid selection input.");
        }
        MemoryCapabilityRegistration[] candidates = _ordered.Where(item => item.ExclusiveGroup == exclusiveGroup)
            .OrderByDescending(item => Requested(item.Id) == MemoryCapabilityMode.Required)
            .ThenBy(item => item.SelectionPriority).ThenBy(item => item.Id, StringComparer.Ordinal).ToArray();
        if (candidates.Length == 0)
        {
            throw new ArgumentException("Exclusive group is not registered.", nameof(exclusiveGroup));
        }
        // Capture each registered immutable fact once; selection does not revisit a mutable caller map.
        var captured = new Dictionary<string, MemoryCapabilityStatus>(StringComparer.Ordinal);
        var admitted = new Dictionary<string, MemoryCapabilityWorkloadAdmission>(StringComparer.Ordinal);
        foreach (MemoryCapabilityRegistration registration in _ordered)
        {
            if (statuses.TryGetValue(registration.Id, out MemoryCapabilityStatus? status) && status is not null)
            {
                captured.Add(registration.Id, status);
            }
            if (admissions.TryGetValue(registration.Id, out MemoryCapabilityWorkloadAdmission? admission) && admission is not null)
            {
                admitted.Add(registration.Id, admission);
            }
        }
        foreach (MemoryCapabilityRegistration candidate in candidates)
        {
            var visited = new HashSet<string>(StringComparer.Ordinal);
            var pending = new Stack<string>();
            pending.Push(candidate.Id);
            bool usable = admitted.TryGetValue(candidate.Id, out MemoryCapabilityWorkloadAdmission? admission)
                && admission.PolicyRevision == Revision && admission.Qualification == MemoryQualification.Qualified
                && admission.Admission == MemoryAdmission.Admitted;
            while (usable && pending.TryPop(out string? id))
            {
                if (!visited.Add(id))
                {
                    continue;
                }
                if (Requested(id) == MemoryCapabilityMode.Disabled || !captured.TryGetValue(id, out MemoryCapabilityStatus? status)
                    || status is null || status.CapabilityId != id || status.PolicyRevision != Revision
                    || status.Requested != Requested(id) || status.Detection != MemoryDetection.Present
                    || status.ReleaseQualification != MemoryQualification.Qualified
                    || status.RuntimeQualification != MemoryQualification.Qualified
                    || status.OnlineState != MemoryOnlineState.Online || string.IsNullOrWhiteSpace(status.EffectivePath))
                {
                    usable = false;
                    break;
                }
                foreach (string parent in _registrations[id].Dependencies)
                {
                    pending.Push(parent);
                }
            }
            if (usable)
            {
                return candidate.Id;
            }
            if (Requested(candidate.Id) == MemoryCapabilityMode.Required)
            {
                return null;
            }
        }
        return null;
    }

    private static bool ValidId(string? id) => !string.IsNullOrWhiteSpace(id) && id.Length <= 128;
}
