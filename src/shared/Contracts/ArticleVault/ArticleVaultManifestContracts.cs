namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Defines the only supported Article Vault schema and control-tree versions.</summary>
public static class ArticleVaultSchemas
{
    public const string RootManifest = "fsusblog.article-vault.root.v1";
    public const string ArticleManifest = "fsusblog.article-vault.article.v1";
    public const string MetadataManifest = "fsusblog.article-vault.metadata.v1";
    public const string Coordinate = "fsusblog.article-vault.coordinate.v1";
    public const int Version = 1;
    public const string ControlTreeVersion = "fsusblog.article-vault.control-tree.v1";
    public const string RootManifestPath = ".fsus/vault.json";
    public const string ArticleManifestDirectory = ".fsus/articles";
    public const string ReceiptDirectory = ".fsus/receipts";
}

/// <summary>Describes mechanically derived Article Vault article states.</summary>
public enum VaultArticleState
{
    Untracked,
    Clean,
    LocalModified,
    ServerModified,
    BothModified,
    LocalCreated,
    ServerCreated,
    LocalDeleted,
    ServerDeleted,
    Conflicted,
    Applying,
    Synced,
    Blocked
}

/// <summary>Describes the line-ending bytes observed in Markdown source.</summary>
public enum VaultNewlineStyle
{
    None,
    Lf,
    CrLf,
    Mixed
}

/// <summary>Content-addresses Markdown bytes while retaining round-trip byte facts.</summary>
public sealed record VaultSourceByteIdentity(
    string Sha256,
    long ByteLength,
    bool HasUtf8Bom,
    VaultNewlineStyle NewlineStyle,
    int TrailingWhitespaceLineCount,
    bool HasFinalNewline);

/// <summary>Captures one versioned base, local, or server article coordinate.</summary>
public sealed record VaultArticleCoordinate(
    string Schema,
    int SchemaVersion,
    bool Present,
    bool Deleted,
    long? ServerRevision,
    VaultSourceByteIdentity? Source,
    string? MetadataManifestSha256,
    string? DependencySha256,
    string? Lifecycle,
    string? PermissionSha256,
    string ContentSha256);

/// <summary>Groups the three coordinates used to derive synchronization state.</summary>
public sealed record VaultArticleCoordinates(
    VaultArticleCoordinate Base,
    VaultArticleCoordinate Local,
    VaultArticleCoordinate Server);

/// <summary>Binds a non-authoritative relative path projection to its digest.</summary>
public sealed record VaultPathProjection(
    string RelativePath,
    string ProjectionSha256);

/// <summary>Defines the fixed paths that comprise the Vault control tree.</summary>
public sealed record VaultControlTree(
    string RootManifestPath,
    string ArticleManifestDirectory,
    string ReceiptDirectory);

/// <summary>Records immutable-operation progress used by state derivation.</summary>
public sealed record VaultOperationWatermarks(
    long Sequence,
    string? LastPlannedOperationIdentity,
    string? LastAppliedOperationIdentity,
    string? LastReceiptSha256,
    string? ApplyingOperationIdentity,
    string? ConflictOperationIdentity,
    string? BlockedReasonCode);

/// <summary>References a content-addressed article manifest from the Vault root.</summary>
public sealed record VaultArticleReference(
    string PortableArticleIdentity,
    string ManifestPath,
    string ManifestSha256,
    string RelativePath);

/// <summary>References a content-addressed operation receipt from the Vault root.</summary>
public sealed record VaultOperationReceiptReference(
    string OperationIdentity,
    long Sequence,
    string ReceiptPath,
    string ReceiptSha256);

/// <summary>Represents the closed and versioned manifest stored at <c>.fsus/vault.json</c>.</summary>
public sealed record ArticleVaultRootManifest(
    string Schema,
    int SchemaVersion,
    string ControlTreeVersion,
    VaultControlTree ControlTree,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    IReadOnlyList<VaultArticleReference> Articles,
    IReadOnlyList<VaultOperationReceiptReference> OperationReceipts,
    string ContentSha256);

/// <summary>Binds an article identity to its coordinates, projection, and operation state.</summary>
public sealed record ArticleVaultArticleManifest(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    VaultPathProjection PathProjection,
    VaultArticleCoordinates Coordinates,
    VaultOperationWatermarks OperationWatermarks,
    VaultArticleState State,
    string ContentSha256);

/// <summary>Contains portable editable metadata without lifecycle or rights authority.</summary>
public sealed record ArticleVaultMetadataManifest(
    string Schema,
    int SchemaVersion,
    string SiteIdentity,
    string VaultIdentity,
    string DeviceIdentity,
    string PortableArticleIdentity,
    string? ServerArticleIdentity,
    string Title,
    string? Summary,
    string Slug,
    string TaxonomySha256,
    string PropertiesSha256,
    string ContentSha256);

/// <summary>Returns a stable fail-closed reason code from Article Vault validation.</summary>
public readonly record struct ArticleVaultValidationResult(bool IsValid, string? ReasonCode)
{
    public static ArticleVaultValidationResult Valid() => new(true, null);

    public static ArticleVaultValidationResult Invalid(string reasonCode) => new(false, reasonCode);
}
