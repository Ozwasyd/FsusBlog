using System;

namespace FsusBlog.Shared.Contracts.Governance;

/// <summary>
/// Declares that the annotated xUnit test method proves one BehaviorContractCatalog ID under one test kind.
/// One method may declare at most one kind; multi-kind coverage requires distinct test methods/IDs.
/// Negative and migration proofs must declare a stable InvariantId or ReasonId.
/// Concurrency proofs must declare a real ConcurrencyHarness identity.
/// </summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]
public sealed class CoversBehaviorAttribute : Attribute
{
    public CoversBehaviorAttribute(string behaviorId, BehaviorTestKind testKind)
    {
        BehaviorId = behaviorId;
        TestKind = testKind;
    }

    public string BehaviorId { get; }

    public BehaviorTestKind TestKind { get; }

    /// <summary>
    /// Stable invariant ID required for negative/migration kinds when ReasonId is absent.
    /// </summary>
    public string? InvariantId { get; init; }

    /// <summary>
    /// Stable expected-reason ID required for negative/migration kinds when InvariantId is absent.
    /// </summary>
    public string? ReasonId { get; init; }

    /// <summary>
    /// Real concurrency harness identity. Required for Concurrency; name-based claims are rejected.
    /// </summary>
    public string? ConcurrencyHarness { get; init; }
}
