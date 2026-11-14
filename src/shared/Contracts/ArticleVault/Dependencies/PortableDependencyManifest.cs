using System.Text.Json.Serialization;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Shared.Contracts.ArticleVault.Dependencies;

/// <summary>One portable dependency format shared by Vault, package import and package export adapters.</summary>
public static class PortableDependencySchemas
{
    public const string Manifest = "fsusblog.portable-dependency-manifest.v1";
    public const string PlanExtension = "fsusblog.article-vault.dependency-plan.v1";
    public const int Version = 1;
}

/// <summary>Selects the exact source coordinate described by a dependency graph.</summary>
public enum VaultDependencySourceSide
{
    Base = 1,
    Local = 2,
    Server = 3
}

/// <summary>Closed permissions required of the canonical dependency authority.</summary>
[Flags]
public enum VaultDependencyRights
{
    Read = 1,
    Reference = 2,
    Materialize = 4,
    Upload = 8
}

/// <summary>Binds a projected authority fact to its host; paths and routes cannot supply this binding.</summary>
public sealed record VaultDependencyBinding(string SiteIdentity, string VaultIdentity, string PortableArticleIdentity);

/// <summary>Current permission and rights facts must be reobserved by their existing authority before execution.</summary>
public sealed record VaultDependencyAdmission(
    ArticleEmbedPermissionStatus Permission,
    VaultDependencyRights RequiredRights,
    VaultDependencyRights GrantedRights,
    string PermissionSha256,
    string RightsSha256,
    string AuthoritySha256);

/// <summary>Closed dependency union. These are immutable projections, never another relation or asset index.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "kind")]
[JsonDerivedType(typeof(VaultAssetDependency), "asset")]
[JsonDerivedType(typeof(VaultLinkDependency), "link")]
[JsonDerivedType(typeof(VaultAnchorDependency), "anchor")]
[JsonDerivedType(typeof(VaultFrozenEmbedDependency), "frozen-embed")]
public abstract record VaultDependencyNode(VaultDependencyBinding Binding, VaultDependencyAdmission Admission);

/// <summary>The GUID is the registered backend AssetId value; only the ledger adapter may supply these facts.</summary>
public sealed record VaultAssetDependency(
    VaultDependencyBinding Binding,
    VaultDependencyAdmission Admission,
    Guid AssetIdentity,
    string ContentSha256,
    string MimeType,
    string Extension,
    long SizeBytes,
    int? WidthPixels,
    int? HeightPixels,
    long? OwnerAdminPrincipalId,
    long ServerRevision) : VaultDependencyNode(Binding, Admission);

/// <summary>Portable mapping supplies a canonical target, never a title, slug, route or file name.</summary>
public sealed record VaultLinkDependency(
    VaultDependencyBinding Binding,
    VaultDependencyAdmission Admission,
    ArticleEmbedTargetIdentity Target,
    VaultDependencyBinding TargetBinding,
    string MappingSha256) : VaultDependencyNode(Binding, Admission);

/// <summary>A canonical source-owned block target; no sidecar IDs or source scanning are admitted here.</summary>
public sealed record VaultAnchorDependency(
    VaultDependencyBinding Binding,
    VaultDependencyAdmission Admission,
    ArticleBlockTarget Target,
    string AnchorContractSha256) : VaultDependencyNode(Binding, Admission);

/// <summary>Consumes an exact frozen coordinate; current/latest resolution is outside this contract.</summary>
public sealed record VaultFrozenEmbedDependency(
    VaultDependencyBinding Binding,
    VaultDependencyAdmission Admission,
    ArticleEmbedDependencyCoordinate Coordinate,
    VaultDependencyBinding TargetBinding,
    string PublicationReceiptSha256,
    long FrozenSourceByteLength) : VaultDependencyNode(Binding, Admission);

/// <summary>Closed semantic edges freeze prerequisite order without a parallel relation index.</summary>
public enum VaultDependencyEdgeKind
{
    Requires = 1,
    FrozenRequires = 2
}

/// <summary>Endpoints are canonical node keys computed by the dependency codec, not display indices.</summary>
public sealed record VaultDependencyEdge(string PrerequisiteKey, string DependentKey, VaultDependencyEdgeKind Kind);

/// <summary>Raw source, all three article coordinates, canonical dependencies and relation facts share one seal.</summary>
public sealed record PortableDependencyManifest(
    string Schema,
    int SchemaVersion,
    VaultDependencyBinding Binding,
    string? ServerArticleIdentity,
    VaultArticleCoordinates Coordinates,
    VaultDependencySourceSide SourceSide,
    VaultSourceByteIdentity Source,
    string RelationSha256,
    IReadOnlyList<VaultDependencyNode> Nodes,
    IReadOnlyList<VaultDependencyEdge> Edges,
    string GraphSha256,
    string ContentSha256);

/// <summary>Freezes the dependencies required before a canonical article operation can be admitted.</summary>
public sealed record VaultDependencyPlanItem(
    string OperationIdentity,
    string GroupIdentity,
    string PortableArticleIdentity,
    PortableDependencyManifest Manifest,
    IReadOnlyList<string> DependencyOrder);

/// <summary>Extends, but never replaces or executes, the canonical immutable sync plan.</summary>
public sealed record ArticleVaultDependencyPlan(
    string Schema,
    int SchemaVersion,
    string SyncPlanSha256,
    string SiteIdentity,
    string VaultIdentity,
    ArticleEmbedResolutionBudgetLimits Budgets,
    IReadOnlyList<VaultDependencyPlanItem> Items,
    IReadOnlyList<string> OperationOrder,
    string ContentSha256);
