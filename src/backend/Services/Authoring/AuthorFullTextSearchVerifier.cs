using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Inspectable manifest of the sole contract registry, with stable ordered rosters.</summary>
public sealed record AuthorSearchRegistrySnapshot(
    string DocumentSchema,
    string QuerySchema,
    string QueryGrammarVersion,
    ImmutableArray<KeyValuePair<AuthorSearchFieldKind, string>> Fields,
    ImmutableArray<KeyValuePair<AuthorSearchFieldKind, int>> FieldWeights,
    AuthorSearchTokenizerDescriptor Tokenizer,
    ImmutableArray<AuthorSearchRankingFactor> RankingFactors,
    ImmutableArray<string> StableTieBreakers,
    ImmutableArray<AuthorSearchOwnerBoundary> OwnerBoundaries,
    string ContentDigest);

/// <summary>
/// A derived token artifact only. Its digest does not authorize content, establish a
/// current source revision, or qualify an index generation. Runtime identity makes the
/// runtime-owned grapheme/normalization implementation observable and drift detectable.
/// </summary>
public sealed record AuthorSearchTokenizedDocument(
    AuthorSearchDocument Document,
    ImmutableArray<AuthorSearchToken> Tokens,
    string RegistryDigest,
    string RuntimeIdentity,
    string ContentDigest);

/// <summary>
/// Independently rereads raw source and the one registry, recomputes token output and
/// rejects even publicly resealed tamper. It grants no parse/permission admission and
/// does not own a second tokenizer, source corpus, query grammar or index.
/// </summary>
public static class AuthorFullTextSearchVerifier
{
    public static AuthorSearchRegistrySnapshot CaptureRegistry()
        => SealRegistry(new(AuthorFullTextSearchContract.DocumentSchema,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.QueryGrammarVersion,
            [.. AuthorFullTextSearchContract.Fields.OrderBy(static pair => pair.Key)],
            [.. AuthorFullTextSearchContract.FieldWeights.OrderBy(static pair => pair.Key)],
            AuthorFullTextSearchContract.Tokenizer, AuthorFullTextSearchContract.RankingFactors,
            AuthorFullTextSearchContract.StableTieBreakers, AuthorFullTextSearchContract.OwnerBoundaries,
            string.Empty));

    public static AuthorSearchRegistrySnapshot SealRegistry(AuthorSearchRegistrySnapshot registry)
        => registry with
        {
            ContentDigest = AuthorFullTextSearchContract.Digest(JsonSerializer.Serialize(registry with
            {
                ContentDigest = string.Empty
            }))
        };

    public static void VerifyRegistry(AuthorSearchRegistrySnapshot registry)
    {
        ArgumentNullException.ThrowIfNull(registry);
        if (registry.ContentDigest != SealRegistry(registry).ContentDigest
            || JsonSerializer.Serialize(registry) != JsonSerializer.Serialize(CaptureRegistry()))
        {
            throw new AuthorSearchContractException("author_search_registry_tampered_or_stale");
        }
    }

    public static AuthorSearchTokenizedDocument CreateTokenDocument(
        AuthorSearchDocument document,
        string rawFieldSource,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        string admittedParserVersion,
        string currentDocumentEpoch)
    {
        AuthorFullTextSearchContract.ValidateDocument(document, rawFieldSource, definitions,
            admittedParserVersion, currentDocumentEpoch);
        return SealTokenDocument(new(document, AuthorFullTextSearchTokenizer.Tokenize(rawFieldSource,
            document.Source, admittedParserVersion, currentDocumentEpoch), CaptureRegistry().ContentDigest,
            RuntimeIdentity(), string.Empty));
    }

    public static AuthorSearchTokenizedDocument SealTokenDocument(AuthorSearchTokenizedDocument document)
        => document with
        {
            ContentDigest = AuthorFullTextSearchContract.Digest(JsonSerializer.Serialize(document with
            {
                ContentDigest = string.Empty
            }))
        };

    public static void VerifyTokenDocument(
        AuthorSearchTokenizedDocument document,
        string rawFieldSource,
        IReadOnlyDictionary<Guid, ArticlePropertyDefinition> definitions,
        string admittedParserVersion,
        string currentDocumentEpoch)
    {
        ArgumentNullException.ThrowIfNull(document);
        if (document.Tokens.IsDefault || document.Tokens.Length > AuthorFullTextSearchTokenizer.MaxTokens
            || document.RegistryDigest != CaptureRegistry().ContentDigest
            || document.RuntimeIdentity != RuntimeIdentity()
            || document.ContentDigest != SealTokenDocument(document).ContentDigest)
        {
            throw new AuthorSearchContractException("author_search_token_document_stale_or_invalid");
        }
        AuthorSearchTokenizedDocument expected = CreateTokenDocument(document.Document, rawFieldSource,
            definitions, admittedParserVersion, currentDocumentEpoch);
        if (!document.Tokens.SequenceEqual(expected.Tokens)
            || document.ContentDigest != expected.ContentDigest)
        {
            throw new AuthorSearchContractException("author_search_token_document_tampered");
        }
    }

    private static string RuntimeIdentity()
        => $"{System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription};"
            + $"{System.Runtime.InteropServices.RuntimeInformation.OSDescription};"
            + $"{CultureInfo.InvariantCulture.CompareInfo.Version.FullVersion}:"
            + $"{CultureInfo.InvariantCulture.CompareInfo.Version.SortId:D}";
}
