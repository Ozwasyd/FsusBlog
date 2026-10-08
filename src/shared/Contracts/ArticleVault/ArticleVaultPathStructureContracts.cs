namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Defines pure name-equivalence policies, not observed native filesystem semantics.</summary>
public enum VaultPathComparisonPolicy
{
    Ordinal,
    OrdinalIgnoreCase,
    CanonicalUnicode,
    CanonicalUnicodeIgnoreCase
}

/// <summary>Classifies a manifest projection without granting filesystem access.</summary>
public enum VaultPathStructuralClass
{
    ManifestSourceProjection,
    RegisteredControlPath,
    Blocked
}

/// <summary>
/// Supplies explicit identity and comparison inputs for structural analysis. The caller cannot
/// establish native root admission, containment, ownership or permissions through this value.
/// </summary>
public sealed record VaultPathStructuralScope(
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string AgentIdentity,
    string RootIdentitySha256,
    string RootManifestSha256,
    VaultPathComparisonPolicy ComparisonPolicy);

/// <summary>Records every spelling in a projection collision without choosing a winner.</summary>
public sealed record VaultPathCollision(
    string ReasonCode,
    IReadOnlyList<string> RelativePaths);

/// <summary>
/// Content-addresses pure path/classification analysis. This result always requires independent
/// native admission and is not a verified root, path capability or filesystem qualification receipt.
/// </summary>
public sealed record VaultPathStructuralAnalysis(
    string Schema,
    int SchemaVersion,
    VaultPathStructuralScope Scope,
    string RelativePath,
    VaultPathStructuralClass Classification,
    string RuleIdentity,
    string RuleRegistrySha256,
    string? PortableArticleIdentity,
    string? ReasonCode,
    IReadOnlyList<string> ObservedRelativePaths,
    IReadOnlyList<VaultPathCollision> Collisions,
    string ContentSha256)
{
    /// <summary>Pure string and manifest checks never establish a native filesystem capability.</summary>
    public bool RequiresNativeAdmission => true;
}
