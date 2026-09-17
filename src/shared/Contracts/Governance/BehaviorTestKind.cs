namespace FsusBlog.Shared.Contracts.Governance;

/// <summary>
/// Stable proof kind for a test method bound to a BehaviorContractCatalog ID.
/// Values must stay aligned with config/contracts/behavior-contracts.json requiredTestKinds.
/// </summary>
public enum BehaviorTestKind
{
    Positive,
    Boundary,
    Negative,
    Concurrency,
    Migration,
    Mutation
}
