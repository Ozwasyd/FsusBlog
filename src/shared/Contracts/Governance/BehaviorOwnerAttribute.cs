using System;

namespace FsusBlog.Shared.Contracts.Governance;

/// <summary>
/// Declares that the annotated type or member is an implementation owner of a BehaviorContractCatalog ID.
/// Stores only the stable behavior ID and optional composition role; never facts, test IDs, docs, or paths.
/// </summary>
[AttributeUsage(
    AttributeTargets.Class | AttributeTargets.Struct | AttributeTargets.Interface | AttributeTargets.Method | AttributeTargets.Property,
    AllowMultiple = true,
    Inherited = false)]
public sealed class BehaviorOwnerAttribute : Attribute
{
    public BehaviorOwnerAttribute(string behaviorId)
    {
        BehaviorId = behaviorId;
    }

    public string BehaviorId { get; }

    /// <summary>
    /// Required when catalog cardinality is many; must match an allowedImplementationOwnerRoles entry.
    /// </summary>
    public string? Role { get; init; }
}
