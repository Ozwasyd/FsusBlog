namespace FsusBlog.Shared.Contracts.Customization;

/// <summary>
/// Strong identity wrapper for a customization profile.
/// </summary>
public readonly record struct CustomizationProfileId(string Value);

/// <summary>
/// Strong version wrapper for a customization profile.
/// </summary>
public readonly record struct CustomizationProfileVersion(long Value);

/// <summary>
/// Strong identity wrapper for a draft session.
/// </summary>
public readonly record struct CustomizationDraftId(string Value);

/// <summary>
/// Strong identity wrapper for a committed changeset.
/// </summary>
public readonly record struct CustomizationChangeSetId(string Value);

/// <summary>
/// Generation counter wrapper for optimistic concurrency control.
/// </summary>
public readonly record struct CustomizationGeneration(long Value);

/// <summary>
/// Unified representation for content digests and ETag integrity verification.
/// </summary>
public sealed record CustomizationDigest(
    string Algorithm,
    string Hash,
    string SchemaVersion,
    string ETag);

/// <summary>
/// Mutation target contract describing a proposed customization mutation.
/// </summary>
public sealed record CustomizationMutationDescriptor(
    string OperationId,
    string TargetType,
    string TargetId,
    CustomizationProfileId ProfileId,
    CustomizationProfileVersion BaseVersion,
    CustomizationGeneration ExpectedGeneration,
    CustomizationChangeSetId ChangeSetId,
    CustomizationDigest Digest,
    string IdempotencyKey);

/// <summary>
/// Asset reference boundary linking a customization slot to an immutable asset object.
/// </summary>
public sealed record CustomizationAssetReference(
    string SlotId,
    string AssetObjectId,
    string VariantId,
    CustomizationDigest ContentDigest,
    string PolicySchemaVersion,
    string ReferenceState);

/// <summary>
/// Permission and audit integration seam for #180 and #182 reuse.
/// </summary>
public sealed record CustomizationOperationContext(
    string ActorId,
    string RequiredCapability,
    bool RequiresStepUp,
    string RequestSignature,
    DateTimeOffset Timestamp);
