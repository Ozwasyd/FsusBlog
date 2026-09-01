namespace FsusBlog.RuntimeRoleObservation;

internal sealed record RuntimeRoleObservation(
    string Schema,
    IReadOnlyList<RuntimeModeObservation> Modes,
    IReadOnlyDictionary<string, IReadOnlyList<string>> StaticRoleCapabilities,
    IReadOnlyList<UnsupportedCombinationObservation> UnsupportedCombinations,
    OwnershipObservation Ownership,
    string ObservationDigest);

internal sealed record RuntimeModeObservation(
    string Id,
    IReadOnlyList<string> StaticRoles,
    bool ClusterMembershipEnabled,
    bool AdaptiveSchedulerEnabled,
    bool DistributedInvalidationEnabled,
    bool LocalInvocationOnly,
    string RoleCombinationState);

internal sealed record UnsupportedCombinationObservation(string Id, string ErrorCode);

internal sealed record OwnershipObservation(
    string Process,
    string Container,
    string Service,
    string CoResidency,
    string Separation,
    string AuthorityState);
