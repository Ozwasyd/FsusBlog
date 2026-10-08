using System.Text.Json.Serialization;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds;

/// <summary>Names the only Blog article-embed contract and its upstream syntax owner.</summary>
public static class ArticleEmbedSchemas
{
    public const int Version = 1;
    public const string Contract = "fsusblog.article-embed-contract.v1";
    public const string ProviderRequest = "fsusblog.article-embed-provider-request.v1";
    public const string ProviderResult = "fsusblog.article-embed-provider-result.v1";
    public const string DependencyCoordinate = "fsusblog.article-embed-dependency-coordinate.v1";
    public const string ParserPackage = "@ozwasyd/element-plus/markdown-runtime";
    public const string ParserExport = "parseMarkdownEmbedLine";
    public const string ParserContract = "fsusui.markdown-embed-directive.v1";
    public const string ProviderRuntime = "fsusblog.article-embed-provider.v1";
    public const string DigestAlgorithm = "sha256";
    public const string CanonicalSerialization = "length-prefixed-utf8-v1";
}

/// <summary>Identifies which closed target grammar the upstream parser selected.</summary>
public enum ArticleEmbedTargetKind : byte
{
    Article = 1,
    Heading = 2,
    Block = 3
}

/// <summary>Separates permission-aware authoring resolution from public publication planning.</summary>
public enum ArticleEmbedRequestedScope : byte
{
    Authoring = 1,
    PublicationPlan = 2
}

/// <summary>States whether a provider returned a complete coordinate or a classified failure.</summary>
public enum ArticleEmbedProviderResultStatus : byte
{
    Resolved = 1,
    Failed = 2
}

/// <summary>Limits provider content to Markdown or a renderer-owned inert projection.</summary>
public enum ArticleEmbedProjectionKind : byte
{
    Markdown = 1,
    SafeProjection = 2
}

/// <summary>Reports the provider-observed target visibility without collapsing unknown into private.</summary>
public enum ArticleEmbedVisibilityStatus : byte
{
    Public = 1,
    Private = 2,
    Unknown = 3
}

/// <summary>Reports the provider-observed target publication lifecycle.</summary>
public enum ArticleEmbedLifecycleStatus : byte
{
    Draft = 1,
    Scheduled = 2,
    Published = 3,
    Archived = 4,
    Deleted = 5,
    Unknown = 6
}

/// <summary>Reports whether the request actor may resolve the selected target.</summary>
public enum ArticleEmbedPermissionStatus : byte
{
    Allowed = 1,
    Denied = 2,
    Unknown = 3
}

/// <summary>Closed error taxonomy. Unknown numeric values are rejected by the validator.</summary>
public enum ArticleEmbedErrorCode : byte
{
    Missing = 1,
    Ambiguous = 2,
    InvalidTarget = 3,
    PermissionDenied = 4,
    PermissionUnknown = 5,
    Private = 6,
    Draft = 7,
    Unpublished = 8,
    Archived = 9,
    Deleted = 10,
    HeadingMissing = 11,
    HeadingDuplicate = 12,
    BlockMissing = 13,
    BlockDuplicate = 14,
    Cycle = 15,
    DepthExceeded = 16,
    SizeExceeded = 17,
    TimeExceeded = 18,
    StaleSource = 19,
    StaleTarget = 20,
    StaleRuntime = 21
}

/// <summary>Preserves the parser-provided half-open UTF-16 range in the host Markdown source.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedSourceRange(int Start, int End);

/// <summary>Identifies the host document and the epoch that invalidates replaced documents.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedDocumentIdentity(string Id, long Epoch);

/// <summary>
/// Stable target identity. Route, slug, title, URL, display text and raw database IDs are deliberately absent.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedTargetIdentity(
    string PortableArticleIdentity,
    ArticleEmbedTargetKind Kind,
    string? HeadingIdentity,
    string? BlockAnchor);

/// <summary>
/// Exact projection emitted by the FsusUI #290 parser. Blog never reconstructs it from Markdown source.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedDirectiveProjection(
    string ParserContract,
    string TargetToken,
    ArticleEmbedTargetKind Mode,
    ArticleEmbedSourceRange RawRange);

/// <summary>Binds resolution to the actor, site and permission snapshot supplied by the caller.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedActorContext(
    string ActorIdentity,
    string SiteIdentity,
    string PermissionContextDigest);

/// <summary>Binds a result to the exact provider implementation and runtime digest.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedRuntimeContext(
    string ProviderId,
    int ProviderVersion,
    string RuntimeVersion,
    string RuntimeDigest);

/// <summary>Defines the complete immutable input accepted by an article embed provider.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedProviderRequest(
    string Schema,
    int SchemaVersion,
    string RequestId,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long SourceRevision,
    ArticleEmbedDirectiveProjection Directive,
    ArticleEmbedTargetIdentity Target,
    ArticleEmbedRequestedScope RequestedScope,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    string ContentDigest,
    string RequestDigest,
    [property: JsonIgnore] CancellationToken AbortSignal);

/// <summary>Reference to controlled Markdown or a renderer-owned safe projection; never HTML or a UI object.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedSafeProjectionReference(
    ArticleEmbedProjectionKind Kind,
    string ProjectionIdentity,
    string ContentDigest);

/// <summary>Provides safe display attribution tied to the resolved source revision.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedAttribution(
    string SourcePortableArticleIdentity,
    long SourceRevision,
    string DisplayText,
    string AttributionDigest);

/// <summary>Records the bounded depth, node, byte and elapsed-time cost of resolution.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedBudgetObservation(
    int Depth,
    int Nodes,
    long Bytes,
    long ElapsedMilliseconds);

/// <summary>
/// Shared dependency coordinate consumed by relation, package and export contracts. Its digest excludes routes and labels.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedDependencyCoordinate(
    string Schema,
    int SchemaVersion,
    ArticleEmbedTargetIdentity Target,
    long ResolvedRevision,
    string TargetVersionIdentity,
    string ProjectionIdentity,
    string ProjectionDigest,
    string DependencyDigest);

/// <summary>Pairs a closed machine-readable error with a non-sensitive provider reason code.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedError(
    ArticleEmbedErrorCode Code,
    string SafeReasonCode);

/// <summary>Returns either one fully bound safe projection coordinate or one classified failure.</summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ArticleEmbedProviderResult(
    string Schema,
    int SchemaVersion,
    string RequestId,
    string RequestDigest,
    ArticleEmbedProviderResultStatus Status,
    ArticleEmbedDependencyCoordinate? Coordinate,
    ArticleEmbedSafeProjectionReference? Projection,
    ArticleEmbedAttribution? Attribution,
    ArticleEmbedVisibilityStatus Visibility,
    ArticleEmbedLifecycleStatus Lifecycle,
    ArticleEmbedPermissionStatus Permission,
    ArticleEmbedBudgetObservation Budgets,
    ArticleEmbedError? Error,
    string ResultDigest);

/// <summary>Represents deterministic contract validation without throwing across provider boundaries.</summary>
public readonly record struct ArticleEmbedValidationResult(bool IsValid, string? ReasonCode)
{
    public static ArticleEmbedValidationResult Valid() => new(true, null);

    public static ArticleEmbedValidationResult Invalid(string reasonCode) => new(false, reasonCode);
}
