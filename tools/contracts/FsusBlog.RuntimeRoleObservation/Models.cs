using System.Text.Json;

namespace FsusBlog.RuntimeRoleObservation;

internal sealed record RuntimeRoleObservation(
    string Schema,
    IReadOnlyList<RuntimeModeObservation> Modes,
    IReadOnlyDictionary<string, IReadOnlyList<string>> StaticRoleCapabilities,
    IReadOnlyList<UnsupportedCombinationObservation> UnsupportedCombinations,
    OwnershipObservation Ownership,
    DeploymentAuthorityObservation DeploymentAuthority,
    SchemaOverlapObservation SchemaOverlap,
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
    string AuthorityState,
    bool ClaimEligible,
    IReadOnlyList<string> FailureReasons);

internal sealed record DeploymentAuthorityObservation(
    string Schema,
    string AuthoritySchema,
    string AuthorityContentDigest,
    IReadOnlyDictionary<string, SourceDigestObservation> SourceDigests,
    JsonElement Application,
    JsonElement VolumeTopology,
    string ObservationDigest);

internal sealed record SourceDigestObservation(string Path, string Digest);

internal sealed record SchemaOverlapObservation(
    string Schema,
    string EvidenceClass,
    int ManifestDescriptorCount,
    int CatalogMetadataCount,
    string ManifestDigest,
    string CatalogDigest,
    string SourceReadiness,
    string TargetReadiness,
    IReadOnlyList<string> MissingExpandFailureCodes,
    IReadOnlyList<string> ConcurrentContractFailureCodes,
    string AuthorityState,
    bool ClaimEligible);

internal sealed record RuntimeRoleDeploymentProbe(
    string Schema,
    string AuthoritySchema,
    string AuthorityContentDigest,
    IReadOnlyDictionary<string, SourceDigestObservation> SourceDigests,
    JsonElement Application,
    OwnershipObservation Ownership,
    JsonElement VolumeTopology,
    string ObservationDigest);
