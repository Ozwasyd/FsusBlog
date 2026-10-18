using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleRelations;
using FsusBlog.Shared.Contracts.BlockLinks;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Canonical AST node classification; transclusions never become link relations.</summary>
public enum ArticleBlockRelationParsedKind : byte
{
    Link = 1,
    Transclusion = 2
}

/// <summary>
/// One original parsed link node with its exact UTF-16 source span and separately resolved stable
/// target. The route is not an identity resolver. Construction establishes no parser provenance.
/// </summary>
public sealed record ArticleBlockRelationParsedLink(
    string NodeIdentity,
    ArticleBlockRelationParsedKind Kind,
    ArticleRelationSourceRange SourceRange,
    ArticleBlockTarget Target);

/// <summary>
/// Original per-article parse/target-authority projection at one generation. Article facts and
/// anchors must come from their canonical owners; neither Allowed nor a digest is an admission proof.
/// Denied targets must not carry route or anchor inventory. Ambiguous inventories are refused whole.
/// </summary>
public sealed record ArticleBlockRelationTargetInventory(
    ArticleRelationActorContext Actor,
    long SourceGeneration,
    ArticleRelationTargetFacts ArticleFacts,
    string ContentDigest,
    string? CanonicalSlug,
    ImmutableArray<BlockAnchorId> Anchors,
    BlockTargetInventoryDiagnostic Diagnostic);

/// <summary>
/// Complete block-link projection of one exact source parse. This is a bounded consumption shape,
/// not another parser, source package, permission authority or transport response. A production
/// adapter must supply original observed parse/identity/rights facts before runtime qualification.
/// </summary>
public sealed record ArticleBlockRelationProductionInput(
    ArticleRelationSourceFacts Source,
    ArticleRelationVisibilityFacts Visibility,
    long SourceGeneration,
    string ParserContract,
    string ParsedSourceDigest,
    int SourceUtf16Length,
    int AnchorContractVersion,
    string AnchorContractDigest,
    ImmutableArray<ArticleBlockRelationParsedLink> Links,
    ImmutableArray<ArticleBlockRelationTargetInventory> Targets)
{
    // Only a completed canonical process envelope supplies parser facts here. Registry,
    // permission and corpus-generation facts remain independently owned and unqualified.
    internal static ArticleBlockRelationProductionInput FromCanonicalParsedSource(
        CanonicalArticleRelationParserBridge.ParsedSource parsedSource,
        ArticleRelationSourceFacts source,
        ArticleRelationVisibilityFacts visibility,
        long sourceGeneration,
        ImmutableArray<CanonicalArticleRelationTargetBinding> bindings,
        ImmutableArray<ArticleBlockRelationTargetInventory> targets)
        => parsedSource.Bind(source, visibility, sourceGeneration, bindings, targets);
}

/// <summary>
/// All-or-nothing canonical set production. A successful set remains an internal fact projection;
/// it is not a permission-safe query response, executable impact plan or observed authority receipt.
/// </summary>
public sealed record ArticleBlockRelationProduction(
    bool Produced,
    string? ReasonCode,
    ArticleRelationSet? Set);

/// <summary>Original non-block set and original block parse projection of the same source revision.</summary>
public sealed record ArticleBlockRelationParsedRevision(
    ArticleRelationSet NonBlockSet,
    ArticleBlockRelationProductionInput BlockInput);

/// <summary>Complete original current/draft/publication family; published facts must be replayed frozen.</summary>
public sealed record ArticleBlockRelationParsedArticle(
    string ArticleIdentity,
    long SourceSequence,
    ImmutableArray<ArticleBlockRelationParsedRevision> Revisions)
{
    public ImmutableArray<ArticleRelationIndexEmbedAdmission> Embeds { get; init; } = [];
}

/// <summary>Bounded original parse page, tied to the exact reader context and corpus generation.</summary>
public sealed record ArticleBlockRelationParsedPage(
    ArticleRelationActorContext Actor,
    long SourceGeneration,
    ImmutableArray<ArticleBlockRelationParsedArticle> Articles,
    bool HasMore);

/// <summary>One complete original parsed article family at the observed source generation.</summary>
public sealed record ArticleBlockRelationParsedArticleRead(
    ArticleRelationActorContext Actor,
    long SourceGeneration,
    ArticleBlockRelationParsedArticle Article);

/// <summary>
/// Owned read port consumed by the backend producer/index integration. Its production adapter must
/// use the sole parser and actual identity/permission authorities; this interface supplies no such
/// implementation or grant. Non-block sets are original facts, never regenerated from block links.
/// </summary>
public interface IArticleBlockRelationParsedSource
{
    Task<ArticleBlockRelationParsedPage> ReadAsync(
        ArticleRelationActorContext actor,
        string? afterArticleIdentity,
        int pageSize,
        long? expectedSourceGeneration,
        CancellationToken cancellationToken);

    Task<ArticleBlockRelationParsedArticleRead> ReadArticleAsync(
        ArticleRelationActorContext actor,
        string articleIdentity,
        long? expectedSourceGeneration,
        CancellationToken cancellationToken);
}
