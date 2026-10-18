using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Author full-text contracts only. This owner neither tokenizes source nor builds,
/// queries, or publishes an index. Property semantics remain definition-owned.
/// </summary>
public static partial class AuthorFullTextSearchContract
{
    public const int SchemaVersion = 3;
    public const string DocumentSchema = "fsusblog.author-full-text-document.v3";
    public const string QuerySchema = "fsusblog.author-full-text-query.v3";
    public const string TokenizerVersion = "fsusblog.author-full-text-tokenizer.v3";
    public const string RankingVersion = "fsusblog.author-full-text-ranking.v2";
    public const string IndexOwner = "author-full-text-index";
    public const string SourceCoordinateAuthority = "fsusui.markdown-source-coordinate-map";
    public const int MaxQueryCharacters = 4_096;
    public const int MaxQueryClauses = 64;
    public const int MaxPageSize = 100;
    public const int MaxHighlights = 256;

    public static IReadOnlyDictionary<AuthorSearchFieldKind, string> Fields
    {
        get;
    } =
        new Dictionary<AuthorSearchFieldKind, string>
        {
            [AuthorSearchFieldKind.Title] = "title",
            [AuthorSearchFieldKind.Summary] = "summary",
            [AuthorSearchFieldKind.MarkdownBody] = "markdown-body",
            [AuthorSearchFieldKind.Heading] = "heading",
            [AuthorSearchFieldKind.Category] = "category",
            [AuthorSearchFieldKind.Tag] = "tag",
            [AuthorSearchFieldKind.Property] = "property"
        }.ToFrozenDictionary();

    public static AuthorSearchTokenizerDescriptor Tokenizer
    {
        get;
    } = new(
        TokenizerVersion,
        "NFC", "invariant-simple-case-fold", "preserve-diacritics",
        "unicode-letter-number-with-attached-marks", "unicode-scalar-unigram",
        "extended-grapheme-sequence", "logical-source-order", "punctuation-separator",
        "source-range-map-required", "ordered-adjacent-tokens",
        AuthorFullTextSearchTokenizer.UnicodeCaseFoldingVersion, "dotnet10-string-info-text-elements");

    /// <summary>Declared deterministic field weights; execution remains query-owner work.</summary>
    public static IReadOnlyDictionary<AuthorSearchFieldKind, int> FieldWeights
    {
        get;
    } =
        new Dictionary<AuthorSearchFieldKind, int>
        {
            [AuthorSearchFieldKind.Title] = 10,
            [AuthorSearchFieldKind.Summary] = 4,
            [AuthorSearchFieldKind.MarkdownBody] = 1,
            [AuthorSearchFieldKind.Heading] = 6,
            [AuthorSearchFieldKind.Category] = 3,
            [AuthorSearchFieldKind.Tag] = 3,
            [AuthorSearchFieldKind.Property] = 2
        }.ToFrozenDictionary();

    public static ImmutableArray<AuthorSearchRankingFactor> RankingFactors
    {
        get;
    } =
        [AuthorSearchRankingFactor.ExactPhrase, AuthorSearchRankingFactor.ExactToken,
            AuthorSearchRankingFactor.FieldWeight, AuthorSearchRankingFactor.HeadingBodyProximity,
            AuthorSearchRankingFactor.LifecycleStatus, AuthorSearchRankingFactor.SourceUpdatedAt];

    public static ImmutableArray<string> StableTieBreakers
    {
        get;
    } =
        ["site-scope-ordinal", "article-id-ascending", "field-kind-ascending", "raw-range-start-ascending"];

    public static ImmutableArray<AuthorSearchOwnerBoundary> OwnerBoundaries
    {
        get;
    } =
        [new("global-author-search", IndexOwner, "current-article-field-documents", "server-permission-filter"),
            new("quick-switcher", "article-entity-query", "article-identities", "server-permission-filter"),
            new("public-search", "public-search-index", "published-public-projection", "public-visibility"),
            new("article-relations", "article-relation-index", "resolved-link-facts", "server-permission-filter")];

    public static void ValidateDocument(
        AuthorSearchDocument document,
        string rawFieldSource,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        string admittedParserVersion,
        string currentDocumentEpoch)
    {
        ArgumentNullException.ThrowIfNull(document);
        ArgumentNullException.ThrowIfNull(rawFieldSource);
        ArgumentNullException.ThrowIfNull(definitions);
        Require(document.Identity is not null && document.Field is not null && document.Source is not null,
            "author_search_document_shape_invalid");
        ValidateIdentity(document.Identity);
        Require(document.SchemaVersion == SchemaVersion
            && document.Schema == DocumentSchema
            && document.TokenizerVersion == TokenizerVersion
            && document.IndexOwner == IndexOwner, "author_search_contract_version_invalid");
        Require(Fields.ContainsKey(document.Field.Kind), "author_search_field_unknown");
        Require(document.Field.ContentDigest == Digest(rawFieldSource), "author_search_field_digest_mismatch");
        ValidateRange(document.Source, rawFieldSource, admittedParserVersion, currentDocumentEpoch);
        Require(document.Source.SourceDigest == document.Field.ContentDigest,
            "author_search_range_digest_mismatch");
        Require(document.Field.Kind == AuthorSearchFieldKind.Heading
            ? !string.IsNullOrWhiteSpace(document.Field.HeadingIdentity)
            : document.Field.HeadingIdentity is null, "author_search_heading_identity_invalid");
        Require(document.Field.Kind == AuthorSearchFieldKind.Property
            ? document.Field.PropertyDefinitionId.HasValue && document.Field.DefinitionSchemaRevision > 0
                && document.Field.PropertyValueType.HasValue
            : document.Field.PropertyDefinitionId is null && document.Field.DefinitionSchemaRevision is null
                && document.Field.PropertyValueType is null,
            "author_search_property_identity_invalid");
        Require(document.Field.Kind is AuthorSearchFieldKind.Category or AuthorSearchFieldKind.Tag
            ? document.Field.TaxonomyId > 0
            : document.Field.TaxonomyId is null, "author_search_taxonomy_identity_invalid");
        Require(document.Field.Kind == AuthorSearchFieldKind.Property
            || document.Field.DefinitionDigest is null && document.Field.PropertyValueDigest is null,
            "author_search_property_identity_invalid");
        if (document.Field.Kind == AuthorSearchFieldKind.Property)
        {
            Require(definitions.TryGetValue(document.Field.PropertyDefinitionId!.Value,
                out ArticlePropertyDefinition? definition) && definition is not null,
                "author_search_property_unknown");
            Require(definition.DefinitionId == document.Field.PropertyDefinitionId.Value,
                "author_search_property_identity_invalid");
            ValidateDefinition(definition, document.Identity.SiteScope, document.Identity.UserId);
            Require(definition.SchemaRevision == document.Field.DefinitionSchemaRevision,
                "author_search_property_schema_stale");
            Require(definition.ValueType == document.Field.PropertyValueType,
                "author_search_property_type_mismatch");
            Require(document.Field.DefinitionDigest is null || document.Field.DefinitionDigest == definition.ContentDigest,
                "author_search_property_schema_stale");
        }
        Require(document.Source.SourceRevision == document.Identity.CurrentRevision,
            "author_search_range_revision_stale");
        Require(IsDigest(document.ContentDigest)
            && document.ContentDigest == SealDocument(document).ContentDigest,
            "author_search_document_digest_invalid");
    }

    public static void ValidateQuery(
        AuthorSearchQuery query,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions)
    {
        ArgumentNullException.ThrowIfNull(query);
        ArgumentNullException.ThrowIfNull(definitions);
        Require(query.SchemaVersion == SchemaVersion && query.Schema == QuerySchema
            && query.TokenizerVersion == TokenizerVersion && query.RankingVersion == RankingVersion
            && query.IndexOwner == IndexOwner, "author_search_contract_version_invalid");
        Require(query.QueryId != Guid.Empty && query.IndexInstanceId != Guid.Empty && query.UserId > 0 && ValidText(query.SiteScope, 128)
            && query.PermissionRevision > 0 && query.IndexGeneration > 0
            && IsDigest(query.PermissionPolicyDigest),
            "author_search_query_identity_invalid");
        Require(query.Scope == AuthorSearchScope.CurrentArticle,
            "author_search_historical_scope_unavailable");
        Require(!query.Clauses.IsDefault && query.Clauses.Length is >= 1 and <= MaxQueryClauses
            && query.PageSize is >= 1 and <= MaxPageSize, "author_search_query_budget_invalid");
        if (query.Cursor is not null)
        {
            ValidateCursor(query.Cursor, query);
        }
        int totalCharacters = 0;
        var seenFilters = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthorSearchClause clause in query.Clauses)
        {
            Require(clause is not null, "author_search_clause_invalid");
            Require(Enum.IsDefined(clause.Kind) && !clause.Values.IsDefaultOrEmpty
                && clause.Values.Length <= MaxQueryClauses, "author_search_clause_invalid");
            foreach (string value in clause.Values)
            {
                Require(ValidText(value, MaxQueryCharacters), "author_search_query_value_invalid");
                totalCharacters = checked(totalCharacters + value.Length);
            }
            Require(totalCharacters <= MaxQueryCharacters, "author_search_query_budget_invalid");
            switch (clause.Kind)
            {
                case AuthorSearchClauseKind.PlainText:
                case AuthorSearchClauseKind.QuotedPhrase:
                    Require(clause.Values.Length == 1 && clause.Field is null
                        && clause.PropertyDefinitionId is null && clause.Operator is null,
                        "author_search_text_clause_invalid");
                    break;
                case AuthorSearchClauseKind.FieldText:
                case AuthorSearchClauseKind.FieldPhrase:
                    Require(clause.Field.HasValue && Fields.ContainsKey(clause.Field.Value)
                        && clause.Field != AuthorSearchFieldKind.Property
                        && clause.Values.Length == 1 && clause.PropertyDefinitionId is null
                        && clause.Operator is null, "author_search_field_clause_invalid");
                    break;
                case AuthorSearchClauseKind.Property:
                    Require(clause.Field == AuthorSearchFieldKind.Property
                        && clause.PropertyDefinitionId.HasValue && clause.Operator is not null,
                        "author_search_property_clause_invalid");
                    Require(definitions.TryGetValue(clause.PropertyDefinitionId!.Value,
                        out ArticlePropertyDefinition? definition) && definition is not null,
                        "author_search_property_unknown");
                    Require(definition.DefinitionId == clause.PropertyDefinitionId.Value,
                        "author_search_property_identity_invalid");
                    ValidateDefinition(definition, query.SiteScope, query.UserId);
                    Require(definition.Filterable, "author_search_property_not_filterable");
                    ArticlePropertyDefinitionContract.ValidateOperator(clause.Operator!, definition.ValueType);
                    // Definition eligibility/operator facts are usable now. Typed operands
                    // still belong to the property authority; strings are never values.
                    throw new AuthorSearchContractException("author_search_typed_property_operand_unavailable");
                case AuthorSearchClauseKind.Status:
                    ValidateSystemFilter(clause);
                    foreach (string value in clause.Values)
                    {
                        Require(value is "draft" or "scheduled" or "published" or "archived",
                            "author_search_status_unknown");
                    }
                    break;
                case AuthorSearchClauseKind.Category:
                case AuthorSearchClauseKind.Tag:
                    ValidateSystemFilter(clause);
                    foreach (string value in clause.Values)
                    {
                        Require(int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture,
                            out int identity) && identity > 0, "author_search_taxonomy_identity_invalid");
                    }
                    break;
                case AuthorSearchClauseKind.Date:
                    Require(clause.Field is null && clause.PropertyDefinitionId is null
                        && clause.Operator is "updated-at.before" or "updated-at.after"
                        && clause.Values.Length == 1, "author_search_date_clause_invalid");
                    Require(DateTimeOffset.TryParseExact(clause.Values[0], "O", CultureInfo.InvariantCulture,
                        DateTimeStyles.None, out _), "author_search_date_value_invalid");
                    break;
                default:
                    throw new AuthorSearchContractException("author_search_clause_unknown");
            }
            if (clause.Kind is not AuthorSearchClauseKind.PlainText and not AuthorSearchClauseKind.QuotedPhrase)
            {
                string filter = $"{clause.Kind}:{clause.Field}:{clause.PropertyDefinitionId}:{clause.Operator}";
                Require(seenFilters.Add(filter), "author_search_duplicate_filter");
            }
        }
        Require(IsDigest(query.ContentDigest) && query.ContentDigest == SealQuery(query).ContentDigest,
            "author_search_query_digest_invalid");
    }

    public static AuthorSearchDocument SealDocument(AuthorSearchDocument document)
        => document with
        {
            ContentDigest = Digest(JsonSerializer.Serialize(document with
            {
                ContentDigest = string.Empty
            }))
        };

    public static AuthorSearchQuery SealQuery(AuthorSearchQuery query)
        => query with
        {
            ContentDigest = Digest(JsonSerializer.Serialize(query with
            {
                ContentDigest = string.Empty
            }))
        };

    /// <summary>
    /// Checks results against the current reader's generation and incarnation. Both
    /// current values must come from the index owner, never from the incoming request.
    /// </summary>
    public static void ValidateResult(
        AuthorSearchResult result,
        AuthorSearchQuery query,
        long currentPermissionRevision,
        long currentIndexGeneration,
        Guid currentIndexInstanceId)
    {
        ArgumentNullException.ThrowIfNull(result);
        ArgumentNullException.ThrowIfNull(query);
        Require(result.SchemaVersion == SchemaVersion && result.IndexOwner == IndexOwner
            && result.TokenizerVersion == TokenizerVersion && result.RankingVersion == RankingVersion
            && query.SchemaVersion == SchemaVersion && query.Schema == QuerySchema
            && query.TokenizerVersion == TokenizerVersion && query.RankingVersion == RankingVersion
            && query.IndexOwner == IndexOwner,
            "author_search_result_version_invalid");
        Require(currentIndexInstanceId != Guid.Empty && result.IndexInstanceId == currentIndexInstanceId
            && result.IndexInstanceId == query.IndexInstanceId
            && result.QueryId == query.QueryId && result.QueryDigest == query.ContentDigest
            && result.PermissionRevision == query.PermissionRevision
            && result.PermissionRevision == currentPermissionRevision
            && result.IndexGeneration == query.IndexGeneration
            && result.IndexGeneration == currentIndexGeneration, "author_search_result_stale");
        Require(!result.Matches.IsDefault && result.Matches.Length <= query.PageSize
            && result.TotalMatches >= result.Matches.Length, "author_search_result_budget_invalid");
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthorSearchMatch match in result.Matches)
        {
            Require(match is not null && match.Document is not null && match.Snippet is not null,
                "author_search_result_shape_invalid");
            AuthorSearchDocument document = match.Document;
            ValidateIdentity(document.Identity);
            Require(document.SchemaVersion == SchemaVersion && document.Schema == DocumentSchema
                && document.TokenizerVersion == TokenizerVersion && document.IndexOwner == IndexOwner
                && Fields.ContainsKey(document.Field.Kind)
                && document.ContentDigest == SealDocument(document).ContentDigest,
                "author_search_result_document_invalid");
            Require(document.Identity.UserId == query.UserId && document.Identity.SiteScope == query.SiteScope
                && document.Identity.Scope == query.Scope
                && document.Identity.PermissionRevision == currentPermissionRevision
                && document.Identity.IndexGeneration == currentIndexGeneration
                && document.Identity.PermissionPolicyDigest == query.PermissionPolicyDigest
                && match.Snippet.DocumentDigest == document.ContentDigest,
                "author_search_result_scope_invalid");
            Require(seen.Add(document.ContentDigest), "author_search_result_duplicate_document");
        }
        Require(result.ContentDigest == SealResult(result).ContentDigest, "author_search_result_digest_invalid");
    }

    public static AuthorSearchResult SealResult(AuthorSearchResult result)
        => result with
        {
            ContentDigest = Digest(JsonSerializer.Serialize(result with
            {
                ContentDigest = string.Empty
            }))
        };

    public static void ValidateSnippet(
        AuthorSearchSnippet snippet,
        AuthorSearchDocument document,
        string rawFieldSource,
        string admittedParserVersion,
        string currentDocumentEpoch)
    {
        ArgumentNullException.ThrowIfNull(snippet);
        Require(snippet.DocumentDigest == document.ContentDigest
            && snippet.SourceDigest == document.Field.ContentDigest
            && snippet.Field == document.Field.Kind
            && snippet.HeadingIdentity == document.Field.HeadingIdentity,
            "author_search_snippet_identity_mismatch");
        ValidateRange(snippet.Context, rawFieldSource, admittedParserVersion, currentDocumentEpoch);
        Require(snippet.Context.SourceDigest == snippet.SourceDigest
            && snippet.Context.SourceRevision == document.Source.SourceRevision
            && snippet.Context.Utf16Start >= document.Source.Utf16Start
            && snippet.Context.Utf16End <= document.Source.Utf16End,
            "author_search_snippet_context_invalid");
        Require(!snippet.Highlights.IsDefault && snippet.Highlights.Length <= MaxHighlights,
            "author_search_highlight_budget_invalid");
        Require(snippet.TruncatedBefore == (snippet.Context.Utf16Start > document.Source.Utf16Start)
            && snippet.TruncatedAfter == (snippet.Context.Utf16End < document.Source.Utf16End),
            "author_search_snippet_truncation_invalid");
        int previousEnd = snippet.Context.Utf16Start;
        foreach (AuthorSearchSourceRange highlight in snippet.Highlights)
        {
            ValidateRange(highlight, rawFieldSource, admittedParserVersion, currentDocumentEpoch);
            Require(highlight.SourceDigest == snippet.SourceDigest
                && highlight.SourceRevision == document.Source.SourceRevision
                && highlight.Utf16Start >= previousEnd
                && highlight.Utf16End <= snippet.Context.Utf16End
                && highlight.Utf16End > highlight.Utf16Start, "author_search_highlight_range_invalid");
            previousEnd = highlight.Utf16End;
        }
    }

    public static void ValidateRange(
        AuthorSearchSourceRange range,
        string rawSource,
        string admittedParserVersion,
        string currentDocumentEpoch)
    {
        ArgumentNullException.ThrowIfNull(range);
        ArgumentNullException.ThrowIfNull(rawSource);
        Require(range.Authority == SourceCoordinateAuthority
            && ValidText(admittedParserVersion, 128) && range.ParserVersion == admittedParserVersion
            && ValidText(currentDocumentEpoch, 128) && range.DocumentEpoch == currentDocumentEpoch
            && range.SourceRevision > 0, "author_search_range_authority_invalid");
        Require(range.Utf16Start >= 0 && range.Utf16End >= range.Utf16Start
            && range.Utf16End <= rawSource.Length, "author_search_raw_range_invalid");
        Require(ScalarBoundary(rawSource, range.Utf16Start) && ScalarBoundary(rawSource, range.Utf16End),
            "author_search_range_splits_scalar");
        Require(range.SourceDigest == Digest(rawSource), "author_search_range_digest_mismatch");
        Require(range.Utf8Start == Encoding.UTF8.GetByteCount(rawSource.AsSpan(0, range.Utf16Start))
            && range.Utf8End == Encoding.UTF8.GetByteCount(rawSource.AsSpan(0, range.Utf16End)),
            "author_search_raw_utf8_range_mismatch");
    }

    public static string Digest(string rawSource)
    {
        try
        {
            return $"sha256:{Convert.ToHexStringLower(SHA256.HashData(new UTF8Encoding(false, true).GetBytes(rawSource)))}";
        }
        catch (EncoderFallbackException)
        {
            throw new AuthorSearchContractException("author_search_source_unicode_invalid");
        }
    }

    private static void ValidateIdentity(AuthorSearchDocumentIdentity identity)
    {
        Require(identity.ArticleId > 0 && identity.UserId > 0 && ValidText(identity.SiteScope, 128)
            && identity.CurrentRevision > 0 && identity.LifecycleRevision > 0
            && identity.PermissionRevision > 0 && identity.IndexGeneration > 0
            && identity.Permission == AuthorSearchPermissionState.Allowed
            && Enum.IsDefined(identity.VisibilityScope) && IsDigest(identity.PermissionPolicyDigest)
            && ValidText(identity.Locale, 32)
            && identity.Scope == AuthorSearchScope.CurrentArticle
            && identity.Status is ArticleStatus.Draft or ArticleStatus.Scheduled or ArticleStatus.Published
                or ArticleStatus.Archived, "author_search_document_identity_invalid");
    }

    private static void ValidateDefinition(ArticlePropertyDefinition definition, string site, int userId)
    {
        ArticlePropertyDefinitionContract.ValidateDefinition(definition);
        Require(definition.SearchEligible && definition.Status == ArticlePropertyDefinitionStatus.Active
            && definition.SchemaVersion == ArticlePropertyDefinitionContract.SchemaVersion
            && definition.Owner.SiteScope == site
            && (definition.Owner.UserId is null || definition.Owner.UserId == userId)
            && ArticlePropertyDefinitionContract.TypeNames.ContainsKey(definition.ValueType),
            "author_search_property_not_eligible");
    }

    private static void ValidateSystemFilter(AuthorSearchClause clause)
        => Require(clause.Field is null && clause.PropertyDefinitionId is null && clause.Operator is null
            && clause.Values.Distinct(StringComparer.Ordinal).Count() == clause.Values.Length,
            "author_search_system_filter_invalid");

    private static bool ScalarBoundary(string source, int offset)
        => offset == 0 || offset == source.Length
            || !(char.IsHighSurrogate(source[offset - 1]) && char.IsLowSurrogate(source[offset]));

    private static bool ValidText(string? value, int limit)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= limit
            && value == value.Trim() && !value.Any(char.IsControl);

    private static bool IsDigest(string? digest)
        => digest is { Length: 71 } && digest.StartsWith("sha256:", StringComparison.Ordinal)
            && digest.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") < 0;

    private static void Require([DoesNotReturnIf(false)] bool condition, string reason)
    {
        if (!condition)
        {
            throw new AuthorSearchContractException(reason);
        }
    }
}

public enum AuthorSearchFieldKind
{
    Title = 0,
    Summary = 1,
    MarkdownBody = 2,
    Heading = 3,
    Category = 4,
    Tag = 5,
    Property = 6
}

public enum AuthorSearchScope
{
    CurrentArticle = 0,
    HistoricalRevisionUnavailable = 1
}

/// <summary>Unknown and denied permission facts cannot become indexed readable documents.</summary>
public enum AuthorSearchPermissionState
{
    Allowed = 1,
    Denied = 2,
    Unknown = 3
}

/// <summary>Author-only scope never shares the public search visibility policy.</summary>
public enum AuthorSearchVisibilityScope
{
    AuthorOnly = 1,
    SiteAuthors = 2
}

public enum AuthorSearchClauseKind
{
    PlainText = 0,
    QuotedPhrase = 1,
    FieldText = 2,
    Status = 3,
    Category = 4,
    Tag = 5,
    Date = 6,
    Property = 7,
    FieldPhrase = 8
}

public enum AuthorSearchRankingFactor
{
    ExactPhrase = 0,
    ExactToken = 1,
    FieldWeight = 2,
    HeadingBodyProximity = 3,
    LifecycleStatus = 4,
    SourceUpdatedAt = 5
}

public sealed record AuthorSearchTokenizerDescriptor(
    string Version, string UnicodeNormalization, string CaseFolding, string Diacritics,
    string LatinCyrillicWordBoundary, string CjkBoundary, string EmojiBoundary,
    string RtlOrder, string PunctuationBoundary, string HighlightMapping, string PhraseBoundary,
    string UnicodeCaseFoldingVersion, string GraphemeSegmentation);

public sealed record AuthorSearchOwnerBoundary(string Consumer, string Owner, string Facts, string Permission);

public sealed record AuthorSearchDocumentIdentity(
    int ArticleId, int UserId, string SiteScope, long CurrentRevision, long LifecycleRevision,
    long PermissionRevision, long IndexGeneration, string Locale, ArticleStatus Status, AuthorSearchScope Scope,
    AuthorSearchPermissionState Permission, AuthorSearchVisibilityScope VisibilityScope, string PermissionPolicyDigest);

/// <summary>
/// Property fields supplied to the index additionally bind the canonical definition and
/// value digests. Shape/token validation alone does not admit a typed property source.
/// </summary>
public sealed record AuthorSearchFieldReference(
    AuthorSearchFieldKind Kind, string ContentDigest, string? HeadingIdentity,
    Guid? PropertyDefinitionId, long? DefinitionSchemaRevision,
    int? TaxonomyId = null, ArticlePropertyValueType? PropertyValueType = null,
    string? DefinitionDigest = null, string? PropertyValueDigest = null);

/// <summary>
/// Raw, half-open coordinates from the canonical parse package. UTF-16 is FsusUI's
/// public coordinate unit; UTF-8 maps the same endpoints without BOM/newline rewriting.
/// This validator checks shape/parity, not permission or authenticity of a parse package.
/// </summary>
public sealed record AuthorSearchSourceRange(
    string Authority, string ParserVersion, string DocumentEpoch, long SourceRevision,
    string SourceDigest, int Utf16Start, int Utf16End, int Utf8Start, int Utf8End);

public sealed record AuthorSearchDocument(
    int SchemaVersion, string Schema, string TokenizerVersion, string IndexOwner,
    AuthorSearchDocumentIdentity Identity, AuthorSearchFieldReference Field,
    AuthorSearchSourceRange Source, string ContentDigest);

public sealed record AuthorSearchClause(
    AuthorSearchClauseKind Kind, AuthorSearchFieldKind? Field, Guid? PropertyDefinitionId,
    string? Operator, ImmutableArray<string> Values);

/// <summary>Version 3 queries require the exact current index incarnation as well as its local generation.</summary>
public sealed record AuthorSearchQuery(
    int SchemaVersion, string Schema, string TokenizerVersion, string RankingVersion, string IndexOwner,
    Guid QueryId, int UserId, string SiteScope, long PermissionRevision, long IndexGeneration,
    AuthorSearchScope Scope, ImmutableArray<AuthorSearchClause> Clauses, int PageSize,
    AuthorSearchCursor? Cursor, string ContentDigest, string PermissionPolicyDigest, Guid IndexInstanceId);

/// <summary>A closed pagination coordinate bound to the query, current visibility and exact index incarnation.</summary>
public sealed record AuthorSearchCursor(
    int SchemaVersion, string QueryContextDigest, long PermissionRevision, long IndexGeneration,
    int ArticleId, AuthorSearchFieldKind Field, int RawStart, string ContentDigest, Guid IndexInstanceId);

public sealed record AuthorSearchSnippet(
    string DocumentDigest, string SourceDigest, AuthorSearchFieldKind Field, string? HeadingIdentity,
    AuthorSearchSourceRange Context, ImmutableArray<AuthorSearchSourceRange> Highlights,
    bool TruncatedBefore, bool TruncatedAfter);

public sealed record AuthorSearchMatch(AuthorSearchDocument Document, AuthorSearchSnippet Snippet);

/// <summary>A result bound to the query and the current index owner's exact incarnation.</summary>
public sealed record AuthorSearchResult(
    int SchemaVersion, string TokenizerVersion, string RankingVersion, string IndexOwner,
    Guid QueryId, string QueryDigest, long PermissionRevision, long IndexGeneration,
    long TotalMatches, ImmutableArray<AuthorSearchMatch> Matches, string ContentDigest, Guid IndexInstanceId);

public sealed class AuthorSearchContractException(string reason) : InvalidOperationException(reason);
