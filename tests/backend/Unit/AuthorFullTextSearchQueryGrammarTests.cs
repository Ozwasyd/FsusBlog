using System.Collections.Immutable;

using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchQueryGrammarTests
{
    [Fact]
    public void Parse_Preserves_Unicode_Phrase_Field_And_System_Facts()
    {
        ImmutableArray<AuthorSearchClause> clauses = AuthorFullTextSearchContract.ParseClauses(
            "中文 \"CAFÉ привет العربية\" field.title:hello status:draft category:12 tag:34 "
            + "updated-at.before:2026-10-08T00:00:00.0000000+00:00");
        Assert.Equal(7, clauses.Length);
        Assert.Equal(AuthorSearchClauseKind.PlainText, clauses[0].Kind);
        Assert.Equal(AuthorSearchClauseKind.QuotedPhrase, clauses[1].Kind);
        Assert.Equal("CAFÉ привет العربية", Assert.Single(clauses[1].Values));
        Assert.Equal(AuthorSearchFieldKind.Title, clauses[2].Field);
        AuthorSearchQuery query = Query(clauses);
        AuthorFullTextSearchContract.ValidateQuery(query, new Dictionary<Guid, ArticlePropertyDefinition>());
    }

    [Fact]
    public void Parse_Quoted_Operators_Are_Literal_And_Escapes_Are_Closed()
    {
        AuthorSearchClause clause = Assert.Single(AuthorFullTextSearchContract.ParseClauses(
            "\"C++ \\\"quote\\\" \\\\ literal\""));
        Assert.Equal("C++ \"quote\" \\ literal", Assert.Single(clause.Values));
        AuthorSearchClause fieldPhrase = Assert.Single(AuthorFullTextSearchContract.ParseClauses(
            "field.heading:\"chapter one\""));
        Assert.Equal(AuthorSearchClauseKind.FieldPhrase, fieldPhrase.Kind);
        Assert.Equal(AuthorSearchFieldKind.Heading, fieldPhrase.Field);
    }

    [Theory]
    [InlineData("/regex/")]
    [InlineData("/regex/i")]
    [InlineData("foo*")]
    [InlineData("a|b")]
    [InlineData("(foo)")]
    [InlineData("foo OR bar")]
    [InlineData("NOT foo")]
    [InlineData("unknown:value")]
    [InlineData("field.unknown:value")]
    [InlineData("field.property:value")]
    [InlineData("property:untyped")]
    [InlineData("status:draft status:published")]
    [InlineData("\"unfinished")]
    [InlineData("\"quote\"tail")]
    [InlineData("\"bad\\n\"")]
    [InlineData("   ")]
    [InlineData("status:")]
    public void Parse_Rejects_Unsupported_Unknown_Duplicate_And_Malformed_Grammar(string text)
        => Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses(text));

    [Theory]
    [InlineData("status:unknown")]
    [InlineData("category:title")]
    [InlineData("tag:0")]
    [InlineData("updated-at.before:yesterday")]
    public void Query_Rejects_Invalid_System_Operands(string text)
        => Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(
            Query(AuthorFullTextSearchContract.ParseClauses(text)), new Dictionary<Guid, ArticlePropertyDefinition>()));

    [Fact]
    public void Parse_And_Query_Reject_Budgets_And_Version_Drift()
    {
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses(
            new string('a', AuthorFullTextSearchContract.MaxQueryCharacters + 1)));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ParseClauses(
            string.Join(' ', Enumerable.Repeat("a", AuthorFullTextSearchContract.MaxQueryClauses + 1))));
        AuthorSearchQuery query = Query(AuthorFullTextSearchContract.ParseClauses("hello"));
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(query with
        {
            Schema = "fsusblog.author-full-text-query.v1"
        }, new Dictionary<Guid, ArticlePropertyDefinition>()));
    }

    private static AuthorSearchQuery Query(ImmutableArray<AuthorSearchClause> clauses)
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.QuerySchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.NewGuid(), 42, "primary", 1, 1, AuthorSearchScope.CurrentArticle, clauses, 20, null, string.Empty,
            AuthorFullTextSearchContract.Digest("permission-policy"), Guid.NewGuid()));
}
