using System.Text.Json.Serialization;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

namespace FsusBlog.Server.Infrastructure.Distributed.Scheduling;

public readonly record struct ResponsibilityId
{
    [JsonConstructor]
    public ResponsibilityId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        string normalized = value.Trim().ToLowerInvariant();
        if (normalized.Length > 96
            || normalized.Any(static character =>
                !char.IsAsciiLetterOrDigit(character) && character is not '.' and not '-'))
        {
            throw new ArgumentOutOfRangeException(nameof(value), value, "Invalid responsibility id.");
        }
        Value = normalized;
    }

    public string Value
    {
        get;
    }

    public override string ToString() => Value;
}

public enum ResponsibilityKind
{
    Listener = 0,
    Consumer = 1,
    Worker = 2,
    Fanout = 3
}

public sealed record ResponsibilityResourceProfile(
    double CpuWeight,
    double MemoryWeight,
    double IoWeight,
    double QueueWeight,
    double LatencyWeight,
    double ErrorWeight)
{
    public void Validate()
    {
        double[] weights =
        [
            CpuWeight,
            MemoryWeight,
            IoWeight,
            QueueWeight,
            LatencyWeight,
            ErrorWeight
        ];
        double total = CpuWeight + MemoryWeight + IoWeight + QueueWeight + LatencyWeight + ErrorWeight;
        if (weights.Any(static value => !double.IsFinite(value) || value < 0)
            || !double.IsFinite(total)
            || total <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(ResponsibilityResourceProfile));
        }
    }
}

public sealed record SchedulingPolicy(
    TimeSpan Cooldown,
    TimeSpan MinimumRunTime,
    double HysteresisScore,
    double MigrationCost,
    double ScaleOutPressure,
    double ScaleInPressure)
{
    public void Validate()
    {
        if (Cooldown < TimeSpan.Zero
            || MinimumRunTime < TimeSpan.Zero
            || !double.IsFinite(HysteresisScore)
            || !double.IsFinite(MigrationCost)
            || !double.IsFinite(ScaleOutPressure)
            || !double.IsFinite(ScaleInPressure)
            || HysteresisScore < 0
            || MigrationCost < 0
            || ScaleOutPressure is <= 0 or > 1
            || ScaleInPressure is < 0 or >= 1
            || ScaleInPressure >= ScaleOutPressure)
        {
            throw new ArgumentOutOfRangeException(nameof(SchedulingPolicy));
        }
    }
}

public sealed record ResponsibilityDescriptor(
    ResponsibilityId Id,
    CapabilityId RequiredCapability,
    ResponsibilityKind Kind,
    int MinReplicas,
    int MaxReplicas,
    ResponsibilityResourceProfile ResourceProfile,
    SchedulingPolicy Policy)
{
    public ResponsibilityDescriptor Validate()
    {
        if (MinReplicas <= 0 || MaxReplicas < MinReplicas || MaxReplicas > 64)
        {
            throw new ArgumentOutOfRangeException(nameof(MinReplicas));
        }
        ResourceProfile.Validate();
        Policy.Validate();
        return this;
    }
}

public sealed record ResponsibilityAssignment(
    ResponsibilityId ResponsibilityId,
    CapabilityId Capability,
    int Replica,
    NodeId NodeId,
    DateTimeOffset AssignedAt,
    double PlacementScore,
    string Reason,
    FencingToken? FencingToken = null);

public sealed record ActiveResponsibility(
    ResponsibilityAssignment Assignment,
    DateTimeOffset ActivatedAt,
    DateTimeOffset LastLeaseRenewedAt);

public sealed record ResponsibilityAssignmentSnapshot(
    long Generation,
    DateTimeOffset ObservedAt,
    string Mode,
    bool Enabled,
    IReadOnlyList<ResponsibilityAssignment> Assignments,
    IReadOnlyList<string> Unassigned)
{
    public static ResponsibilityAssignmentSnapshot Empty(
        ClusterRuntimeMode mode,
        DateTimeOffset observedAt,
        bool enabled)
        => new(
            0,
            observedAt,
            ClusterMembershipWireNames.Mode(mode),
            enabled,
            [],
            []);
}

public interface IResponsibilityAssignmentPlanner
{
    ValueTask<ResponsibilityAssignmentSnapshot> PlanAsync(
        ResponsibilityAssignmentSnapshot previous,
        CancellationToken cancellationToken);
}

public interface IResponsibilityRuntime
{
    ValueTask ActivateAsync(
        ResponsibilityAssignment assignment,
        CancellationToken cancellationToken);

    ValueTask DeactivateAsync(
        ResponsibilityId responsibilityId,
        CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<ActiveResponsibility>> ListActiveAsync(
        CancellationToken cancellationToken);
}

public interface IResponsibilityActivationView
{
    bool IsCapabilityActive(CapabilityId capability);
}

public interface IResponsibilityAssignmentSnapshotProvider
{
    ResponsibilityAssignmentSnapshot Capture();
}
