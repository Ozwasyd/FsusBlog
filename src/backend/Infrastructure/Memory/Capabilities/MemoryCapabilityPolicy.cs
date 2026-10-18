namespace FsusBlog.Server.Infrastructure.Memory.Capabilities;

public enum MemoryCapabilityMode
{
    Auto = 0,
    Disabled = 1,
    Required = 2
}

public enum MemoryDetection
{
    Unknown, Absent, Present, Unsupported, Faulted
}
public enum MemoryQualification
{
    NotVerified, Qualified, Rejected
}
public enum MemoryOnlineState
{
    Offline, Qualifying, Online, Draining, Disabled, Faulted
}
public enum MemoryAdmission
{
    NotEvaluated, Admitted, BudgetRejected, Ineligible, Unavailable, Cancelled
}

// CONFIGURATION: The existing configuration authority owns integration of this normalizer.
// It cannot load drivers, allocate backing, probe hardware or approve a release.
public static class MemoryCapabilityPolicy
{
    public static MemoryCapabilityMode Parse(string? value)
        => value switch
        {
            null => MemoryCapabilityMode.Auto,
            "Auto" => MemoryCapabilityMode.Auto,
            "Disabled" => MemoryCapabilityMode.Disabled,
            "Required" => MemoryCapabilityMode.Required,
            _ => throw new ArgumentException("Expected Auto, Disabled or Required; omission means Auto.", nameof(value))
        };

    public static MemoryCapabilityMode Validate(MemoryCapabilityMode value)
        => Enum.IsDefined(value) ? value : throw new ArgumentOutOfRangeException(nameof(value));
}

public sealed record MemoryCapabilityStatus(
    string CapabilityId,
    ulong PolicyRevision,
    MemoryCapabilityMode Requested,
    MemoryDetection Detection,
    MemoryQualification ReleaseQualification,
    MemoryQualification RuntimeQualification,
    MemoryOnlineState OnlineState,
    string? EffectivePath,
    MemoryAdmission LastAdmission,
    string Reason);

public sealed class MemoryCapabilityPolicyRevision
{
    private readonly IReadOnlyDictionary<string, MemoryCapabilityMode> _requested;

    public MemoryCapabilityPolicyRevision(ulong revision, IReadOnlyDictionary<string, MemoryCapabilityMode> requested)
    {
        ArgumentNullException.ThrowIfNull(requested);
        if (revision == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(revision));
        }
        var copy = new Dictionary<string, MemoryCapabilityMode>(StringComparer.Ordinal);
        foreach ((string id, MemoryCapabilityMode mode) in requested)
        {
            if (string.IsNullOrWhiteSpace(id))
            {
                throw new ArgumentException("Capability ID is required.", nameof(requested));
            }
            copy.Add(id, MemoryCapabilityPolicy.Validate(mode));
        }
        Revision = revision;
        _requested = new System.Collections.ObjectModel.ReadOnlyDictionary<string, MemoryCapabilityMode>(copy);
    }

    public ulong Revision
    {
        get;
    }
    public MemoryCapabilityMode Requested(string capabilityId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(capabilityId);
        return _requested.GetValueOrDefault(capabilityId, MemoryCapabilityMode.Auto);
    }

    public bool HasRequiredDependencyConflict(string child, string parent)
        => Requested(child) == MemoryCapabilityMode.Required && Requested(parent) == MemoryCapabilityMode.Disabled;
}
