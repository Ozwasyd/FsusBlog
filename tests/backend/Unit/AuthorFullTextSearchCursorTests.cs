using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorFullTextSearchCursorTests
{
    [Fact]
    public void Cursor_Binds_Query_Permission_Generation_And_Stable_Last_Key()
    {
        AuthorSearchQuery query = Query("hello");
        AuthorSearchCursor cursor = AuthorFullTextSearchContract.SealCursor(new(
            AuthorFullTextSearchContract.SchemaVersion, AuthorFullTextSearchContract.QueryContextDigest(query),
            query.PermissionRevision, query.IndexGeneration, 7, AuthorSearchFieldKind.MarkdownBody, 0, string.Empty));
        AuthorSearchQuery next = AuthorFullTextSearchContract.SealQuery(query with
        {
            Cursor = cursor
        });
        AuthorFullTextSearchContract.ValidateQuery(next, new Dictionary<Guid, ArticlePropertyDefinition>());
        foreach (AuthorSearchCursor mutation in new[]
        {
            cursor with { SchemaVersion = 1 },
            cursor with { PermissionRevision = 2 },
            cursor with { IndexGeneration = 2 },
            cursor with { ArticleId = 0 },
            cursor with { Field = (AuthorSearchFieldKind)999 },
            cursor with { RawStart = -1 },
            cursor with { QueryContextDigest = AuthorFullTextSearchContract.QueryContextDigest(Query("other")) }
        })
        {
            Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(
                AuthorFullTextSearchContract.SealQuery(query with
                {
                    Cursor = AuthorFullTextSearchContract.SealCursor(mutation)
                }), new Dictionary<Guid, ArticlePropertyDefinition>()));
        }
        Assert.Throws<AuthorSearchContractException>(() => AuthorFullTextSearchContract.ValidateQuery(
            AuthorFullTextSearchContract.SealQuery(next with
            {
                PermissionPolicyDigest = AuthorFullTextSearchContract.Digest("changed-policy")
            }), new Dictionary<Guid, ArticlePropertyDefinition>()));
    }

    private static AuthorSearchQuery Query(string text)
        => AuthorFullTextSearchContract.SealQuery(new(AuthorFullTextSearchContract.SchemaVersion,
            AuthorFullTextSearchContract.QuerySchema, AuthorFullTextSearchContract.TokenizerVersion,
            AuthorFullTextSearchContract.RankingVersion, AuthorFullTextSearchContract.IndexOwner,
            Guid.NewGuid(), 42, "primary", 1, 1, AuthorSearchScope.CurrentArticle,
            AuthorFullTextSearchContract.ParseClauses(text), 20, null, string.Empty,
            AuthorFullTextSearchContract.Digest("permission-policy")));
}
