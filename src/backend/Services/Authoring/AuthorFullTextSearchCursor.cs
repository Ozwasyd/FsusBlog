using System.Text.Json;

namespace FsusBlog.Server.Services.Authoring;

public static partial class AuthorFullTextSearchContract
{
    /// <summary>Seals pagination facts only; it is not permission or query-execution authority.</summary>
    public static AuthorSearchCursor SealCursor(AuthorSearchCursor cursor)
        => cursor with
        {
            ContentDigest = Digest(JsonSerializer.Serialize(cursor with
            {
                ContentDigest = string.Empty
            }))
        };

    public static string QueryContextDigest(AuthorSearchQuery query)
        => SealQuery(query with
        {
            Cursor = null
        }).ContentDigest;

    private static void ValidateCursor(AuthorSearchCursor cursor, AuthorSearchQuery query)
    {
        Require(cursor.SchemaVersion == SchemaVersion && cursor.ArticleId > 0
            && Fields.ContainsKey(cursor.Field) && cursor.RawStart >= 0
            && cursor.PermissionRevision == query.PermissionRevision
            && cursor.IndexGeneration == query.IndexGeneration
            && cursor.QueryContextDigest == QueryContextDigest(query)
            && IsDigest(cursor.ContentDigest) && cursor.ContentDigest == SealCursor(cursor).ContentDigest,
            "author_search_cursor_invalid_or_stale");
    }
}
