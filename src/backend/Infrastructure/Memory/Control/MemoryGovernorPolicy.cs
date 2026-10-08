using System.Collections.ObjectModel;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;

namespace FsusBlog.Server.Infrastructure.Memory.Control;

// QUALIFICATION: Only the existing baseline verifier may supply a qualified binding.
// Shape validation and deterministic fixture decisions do not verify an evidence file.
public sealed record MemoryGovernorBaselineBinding(string CandidateCommit, string EvidenceIdentity,
    string EvidenceDigest, DateTimeOffset FrozenAt, MemoryQualification Qualification);

public sealed record MemoryGovernorResourcePolicy(ResourceDomainId Domain, long NormalTarget,
    long PressureTarget, long CriticalTarget, long CriticalHeadroom, long EntryHeadroom,
    long ExitHeadroom, long MaximumGrowthPerSecond, bool RequiresExternalConstraint);

public sealed record MemoryGovernorResourcePlan(MemoryGovernorResourcePolicy Policy,
    string CapacityIdentity, MemoryResourceUnit Unit);

/// <summary>
/// Immutable numerical inputs from the existing frozen baseline/policy owner.
/// No default thresholds, calibration, controller activation or ledger mutation.
/// </summary>
public sealed class MemoryGovernorPolicy
{
    public MemoryGovernorPolicy(ulong revision, ulong accountingRevision, MemoryGovernorBaselineBinding baseline,
        MemoryResourceTopology topology, IEnumerable<MemoryGovernorResourcePolicy> resources,
        TimeSpan maximumSourceAge, TimeSpan stableRecoveryWindow)
    {
        ArgumentNullException.ThrowIfNull(baseline);
        ArgumentNullException.ThrowIfNull(topology);
        ArgumentNullException.ThrowIfNull(resources);
        if (revision == 0 || accountingRevision == 0 || maximumSourceAge <= TimeSpan.Zero
            || stableRecoveryWindow <= TimeSpan.Zero || !Enum.IsDefined(baseline.Qualification)
            || !ValidDigest(baseline.CandidateCommit, 40) || !ValidDigest(baseline.EvidenceDigest, 64)
            || string.IsNullOrWhiteSpace(baseline.EvidenceIdentity) || baseline.EvidenceIdentity.Length > 128)
        {
            throw new ArgumentException("Frozen policy needs bounded, explicit candidate/evidence/revision/time inputs.");
        }
        var plans = new Dictionary<string, MemoryGovernorResourcePlan>(StringComparer.Ordinal);
        foreach (MemoryGovernorResourcePolicy resource in resources.Take(topology.DomainCount + 1))
        {
            ArgumentNullException.ThrowIfNull(resource);
            MemoryResourceUnit unit = topology.Unit(resource.Domain);
            if (plans.Count == topology.DomainCount || resource.NormalTarget < 0
                || resource.PressureTarget < resource.CriticalTarget || resource.CriticalTarget < 0
                || resource.NormalTarget < resource.PressureTarget || resource.MaximumGrowthPerSecond <= 0
                || resource.CriticalHeadroom < 0 || resource.EntryHeadroom <= resource.CriticalHeadroom
                || resource.ExitHeadroom <= resource.EntryHeadroom
                || resource.RequiresExternalConstraint && unit != MemoryResourceUnit.Bytes)
            {
                throw new ArgumentException("Invalid finite target, hysteresis, growth or external scope policy.", nameof(resources));
            }
            plans.Add(topology.CapacityIdentity(resource.Domain), new(resource,
                topology.CapacityIdentity(resource.Domain), unit));
        }
        if (plans.Count == 0 || !plans.Values.Any(plan => plan.Policy.RequiresExternalConstraint))
        {
            throw new ArgumentException("At least one finite, explicitly scoped external-pressure resource is required.", nameof(resources));
        }
        Revision = revision;
        AccountingRevision = accountingRevision;
        Baseline = baseline;
        MaximumSourceAge = maximumSourceAge;
        StableRecoveryWindow = stableRecoveryWindow;
        Resources = new ReadOnlyDictionary<string, MemoryGovernorResourcePlan>(plans);
    }

    public ulong Revision
    {
        get;
    }
    public ulong AccountingRevision
    {
        get;
    }
    public MemoryGovernorBaselineBinding Baseline
    {
        get;
    }
    public TimeSpan MaximumSourceAge
    {
        get;
    }
    public TimeSpan StableRecoveryWindow
    {
        get;
    }
    public IReadOnlyDictionary<string, MemoryGovernorResourcePlan> Resources
    {
        get;
    }

    internal static bool ValidDigest(string? value, int length)
        => value?.Length == length && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
}
