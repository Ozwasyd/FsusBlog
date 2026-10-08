using System.Text.Json;

using FsusBlog.Contracts.Schema;

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
    string Stage,
    string EvidenceClass,
    string ReceiptFormat,
    CurrentSchemaIdentity Target,
    CurrentSchemaProducerIdentity Producer,
    int EntityTableCount,
    int RequiredRecipeCount,
    string InputDigest,
    string NativeVerifier,
    string NativeStage,
    bool ActualDatabaseObserved,
    bool NativeClaimEligible);

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
