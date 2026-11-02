using System.Text;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchVerifierTests
{
    private static readonly IReadOnlyDictionary<Guid, ArticlePropertyDefinition> s_definitions =
        new Dictionary<Guid, ArticlePropertyDefinition>();

    [Fact]
    public void Registry_Rejects_Resealed_Versions_Owners_Weights_And_Ranking_Tamper()
    {
        AuthorSearchRegistrySnapshot registry = AuthorFullTextSearchVerifier.CaptureRegistry();
        AuthorFullTextSearchVerifier.VerifyRegistry(registry);
        foreach (AuthorSearchRegistrySnapshot mutation in new[]
        {
            registry with { DocumentSchema = "historical-default" },
            registry with { QueryGrammarVersion = "second-query-grammar" },
            registry with { FieldWeights = [new(AuthorSearchFieldKind.Title, 999)] },
            registry with { Fields = [new((AuthorSearchFieldKind)100, "html")] },
            registry with { StableTieBreakers = ["views-descending"] },
            registry with { RankingFactors = [(AuthorSearchRankingFactor)100] },
            registry with { OwnerBoundaries = [new("global-author-search", "public-search-index", "all-history", "client")] },
            registry with { Tokenizer = registry.Tokenizer with { UnicodeCaseFoldingVersion = "unknown" } }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchVerifier.VerifyRegistry(
                AuthorFullTextSearchVerifier.SealRegistry(mutation)));
        }
    }

    [Fact]
    public void Token_Document_Verifier_Recomputes_From_Exact_Raw_Source()
    {
        const string Source = "👩‍💻 cafe\u0301 中文 العربية";
        AuthorSearchDocument field = Document(Source);
        AuthorSearchTokenizedDocument tokens = AuthorFullTextSearchVerifier.CreateTokenDocument(
            field, Source, s_definitions, "canonical-parser", "document:1");
        AuthorFullTextSearchVerifier.VerifyTokenDocument(tokens, Source, s_definitions,
            "canonical-parser", "document:1");
        Assert.DoesNotContain(Source, tokens.ContentDigest);
        foreach (AuthorSearchTokenizedDocument mutation in new[]
        {
            tokens with { Tokens = [.. tokens.Tokens.Reverse()] },
            tokens with { Tokens = [.. tokens.Tokens.Skip(1)] },
            tokens with { Tokens = [tokens.Tokens[0] with { Term = "secret-mutated" }] },
            tokens with { Tokens = [tokens.Tokens[0] with { Position = 999 }] },
            tokens with { RegistryDigest = AuthorFullTextSearchContract.Digest("public-registry") },
            tokens with { RuntimeIdentity = "unknown-grapheme-runtime" }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchVerifier.VerifyTokenDocument(
                AuthorFullTextSearchVerifier.SealTokenDocument(mutation), Source, s_definitions,
                "canonical-parser", "document:1"));
        }
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchVerifier.VerifyTokenDocument(
            tokens, Source + "changed", s_definitions, "canonical-parser", "document:1"));
    }

    private static AuthorSearchDocument Document(string source)
    {
        string digest = AuthorFullTextSearchContract.Digest(source);
        return AuthorFullTextSearchContract.SealDocument(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.DocumentSchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.IndexOwner,
            new(7, 42, "primary", 1, 1, 1, 1, "en", ArticleStatus.Draft, AuthorSearchScope.CurrentArticle,
                AuthorSearchPermissionState.Allowed, AuthorSearchVisibilityScope.AuthorOnly,
                AuthorFullTextSearchContract.Digest("permission-policy")),
            new(AuthorSearchFieldKind.MarkdownBody, digest, null, null, null),
            new(AuthorFullTextSearchContract.SourceCoordinateAuthority, "canonical-parser", "document:1",
                1, digest, 0, source.Length, 0, Encoding.UTF8.GetByteCount(source)), string.Empty));
    }

    [Theory]
    [InlineData(AuthorSearchPermissionState.Denied)]
    [InlineData(AuthorSearchPermissionState.Unknown)]
    [InlineData((AuthorSearchPermissionState)999)]
    public void Token_Document_Rejects_Denied_And_Unknown_Source_Permission(AuthorSearchPermissionState permission)
    {
        AuthorSearchDocument document = Document("private");
        AuthorSearchDocument mutation = AuthorFullTextSearchContract.SealDocument(document with
        {
            Identity = document.Identity with
            {
                Permission = permission
            }
        });
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchVerifier.CreateTokenDocument(
            mutation, "private", s_definitions, "canonical-parser", "document:1"));
    }
}
