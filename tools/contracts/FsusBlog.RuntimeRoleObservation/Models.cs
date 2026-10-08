using System.Text.Json;

namespace FsusBlog.RuntimeRoleObservation;

internal sealed record RuntimeRoleObservation(
    string Schema,
    IReadOnlyList<RuntimeModeObservation> Modes,
    IReadOnlyDictionary<string, IReadOnlyList<string>> StaticRoleCapabilities,
    IReadOnlyList<UnsupportedCombinationObservation> UnsupportedCombinations,
    OwnershipObservation Ownership,
    DeploymentAuthorityObservation DeploymentAuthority,
    CurrentSchemaContractObservation CurrentSchemaContract,
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
    JsonElement EffectiveCompose,
    JsonElement Application,
    JsonElement VolumeTopology,
    string ObservationDigest);

internal sealed record SourceDigestObservation(string Path, string Digest);

internal sealed record CurrentSchemaContractObservation(
    string Schema,
    string EvidenceStage,
    string EvidenceClass,
    string ReceiptFormat,
    int MaximumEncodedBytes,
    bool FixtureOnly,
    bool NativeQualification,
    string CodecType,
    string AdmissionType,
    bool ContractValidated,
    string FixtureArtifactSha256,
    string FixtureContentDigest,
    IReadOnlyList<string> PositiveControls,
    IReadOnlyDictionary<string, string> RefusalControls,
    string ObservationDigest);

internal sealed record RuntimeRoleDeploymentProbe(
    string Schema,
    string AuthoritySchema,
    string AuthorityContentDigest,
    IReadOnlyDictionary<string, SourceDigestObservation> SourceDigests,
    JsonElement EffectiveCompose,
    JsonElement Application,
    OwnershipObservation Ownership,
    JsonElement VolumeTopology,
    string ObservationDigest);
