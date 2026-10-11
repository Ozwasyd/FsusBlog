using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Services.Authoring;

using Microsoft.AspNetCore.DataProtection;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthorArticleQueryCursorCodecTests
{
    [Fact]
    public void Cursor_RoundTripsProtectedRankAnchorOnlyWithExactBinding()
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryCursor cursor = Cursor();
        string value = codec.Encode(cursor);
        Assert.True(codec.TryDecode(value, cursor.Binding, out var anchor, out var reason));
        Assert.Equal(cursor.Anchor, anchor);
        Assert.Null(reason);
        Assert.True(codec.TryDecode(null, cursor.Binding, out anchor, out reason));
        Assert.Null(anchor);
        Assert.Null(reason);
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("request")]
    [InlineData("source")]
    [InlineData("history")]
    [InlineData("permission-digest")]
    [InlineData("permission-revision")]
    [InlineData("site")]
    [InlineData("session")]
    public void Cursor_CurrentAuthorityMismatchNeverExposesAnchor(string field)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryCursor cursor = Cursor();
        AuthorArticleQueryCursorBinding changed = field switch
        {
            "owner" => cursor.Binding with { Owner = new(7, "other-site") },
            "request" => cursor.Binding with { RequestDigest = Hash("changed") },
            "source" => cursor.Binding with { SourceDigest = Hash("changed") },
            "history" => cursor.Binding with { HistoryProjectionDigest = Hash("changed") },
            "permission-digest" => cursor.Binding with { PermissionDigest = Hash("changed") },
            "permission-revision" => cursor.Binding with { PermissionRevision = Hash("changed") },
            "site" => cursor.Binding with { SiteRevision = Hash("changed") },
            _ => cursor.Binding with { SessionRevision = Hash("changed") }
        };
        Assert.False(codec.TryDecode(codec.Encode(cursor), changed, out var anchor, out var reason));
        Assert.Null(anchor);
        Assert.Equal("author_article_query_cursor_stale", reason);
    }

    [Fact]
    public void Cursor_ForeignPurposeAndTamperingNeverExposeAnchor()
    {
        var provider = new EphemeralDataProtectionProvider();
        var codec = new AuthorArticleQueryCursorCodec(provider);
        var other = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryCursor cursor = Cursor();
        string protectedValue = codec.Encode(cursor);
        Assert.False(other.TryDecode(protectedValue, cursor.Binding, out var anchor, out _));
        Assert.Null(anchor);
        string tampered = (protectedValue[0] == 'A' ? "B" : "A") + protectedValue[1..];
        Assert.False(codec.TryDecode(tampered, cursor.Binding, out anchor, out _));
        Assert.Null(anchor);
        var history = new AuthorRecentArticleHistoryCursorCodec(provider);
        string historyCursor = history.Encode(new(new(7, "site-a"), 1, Hash("collection"), Hash("permission"),
            Hash("site"), Hash("session"), new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc), 1));
        Assert.False(codec.TryDecode(historyCursor, cursor.Binding, out anchor, out _));
        Assert.Null(anchor);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("AA=")]
    [InlineData("A")]
    [InlineData("*")]
    public void Cursor_NonCanonicalEncodingIsInvalid(string value)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        Assert.False(codec.TryDecode(value, Cursor().Binding, out var anchor, out var reason));
        Assert.Null(anchor);
        Assert.Equal("author_article_query_cursor_invalid", reason);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("ranking")]
    [InlineData("identity")]
    [InlineData("article")]
    [InlineData("distance")]
    [InlineData("ordinal")]
    public void Cursor_InvalidContractCannotBeProtected(string field)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryCursor cursor = Cursor();
        cursor = field switch
        {
            "version" => cursor with { SchemaVersion = 2 },
            "ranking" => cursor with { RankingId = "unknown" },
            "identity" => cursor with { Binding = cursor.Binding with { SourceDigest = "invalid" } },
            "article" => cursor with { Anchor = cursor.Anchor with { ArticleId = 0 } },
            "distance" => cursor with { Anchor = cursor.Anchor with { TitleDistance = 1 } },
            _ => cursor with { Anchor = cursor.Anchor with { RecentOrdinal = 0 } }
        };
        if (field == "identity")
        {
            Assert.Throws<AuthorRecentArticleHistoryValidationException>(() => codec.Encode(cursor));
        }
        else
        {
            Assert.Throws<ArgumentException>(() => codec.Encode(cursor));
        }
    }

    [Fact]
    public void RequestDigest_NormalizesEquivalentTextAndScopeOrderWithoutChangingIdentity()
    {
        AuthorArticleQueryRequest request = Request() with
        {
            QueryText = " café ",
            Statuses = [AuthorArticleQueryStatus.Draft, AuthorArticleQueryStatus.Published],
            Buckets = [AuthorArticleQueryBucket.Draft, AuthorArticleQueryBucket.Published]
        };
        string digest = AuthorArticleQueryCursorCodec.ComputeRequestDigest(request);
        Assert.Equal(digest, AuthorArticleQueryCursorCodec.ComputeRequestDigest(request with
        {
            QueryText = "CAFE\u0301",
            Statuses = request.Statuses.Reverse().ToArray(),
            Buckets = request.Buckets.Reverse().ToArray(),
            Cursor = "opaque-next-page"
        }));
        Assert.NotEqual(digest, AuthorArticleQueryCursorCodec.ComputeRequestDigest(request with
        {
            QueryText = "cafe"
        }));
    }

    [Fact]
    public void RequestDigest_BindsCancellationIdentityAndEveryOriginalQueryScope()
    {
        AuthorArticleQueryRequest request = Request();
        string digest = AuthorArticleQueryCursorCodec.ComputeRequestDigest(request);
        foreach (var changed in new[]
        {
            request with { Owner = new(8, "site-a") },
            request with { Owner = new(7, "site-b") },
            request with { RequestId = Guid.CreateVersion7() },
            request with { RequestSequence = 2 },
            request with { QueryText = "other" },
            request with { Locale = "en-US" },
            request with { Limit = 20 },
            request with { Statuses = [AuthorArticleQueryStatus.Published] },
            request with { Buckets = [AuthorArticleQueryBucket.Published] }
        })
        {
            Assert.NotEqual(digest, AuthorArticleQueryCursorCodec.ComputeRequestDigest(changed));
        }
    }

    private static AuthorArticleQueryRequest Request()
        => new(1, new(7, "site-a"), Guid.CreateVersion7(), 1, "article", [AuthorArticleQueryStatus.Draft],
            [AuthorArticleQueryBucket.Draft], "zh-CN", AuthorArticleQueryContract.Collation, 10, null);

    [Fact]
    public void RequestCursor_PreservesOriginalPurposeAndCanonicalRequestIdentity()
    {
        var provider = new EphemeralDataProtectionProvider();
        var codec = new AuthorArticleQueryCursorCodec(provider);
        AuthorArticleQueryRequest request = Request() with
        {
            QueryText = " café ",
            Statuses = [AuthorArticleQueryStatus.Draft, AuthorArticleQueryStatus.Published],
            Buckets = [AuthorArticleQueryBucket.Draft, AuthorArticleQueryBucket.Published]
        };
        AuthorArticleQueryCursor cursor = BoundCursor(request);
        string value = codec.EncodeForRequest(request, cursor);
        byte[] payload = Convert.FromBase64String(value.Replace('-', '+').Replace('_', '/')
            + new string('=', (4 - value.Length % 4) % 4));
        AuthorArticleQueryCursor? original = System.Text.Json.JsonSerializer.Deserialize<AuthorArticleQueryCursor>(
            provider.CreateProtector("FsusBlog.AuthorArticleQueryCursor.v1").Unprotect(payload));
        Assert.Equal(cursor, original);
        Assert.True(codec.TryDecode(value, cursor.Binding, out var anchor, out var reason));
        Assert.Equal(cursor.Anchor, anchor);
        Assert.Null(reason);
        Assert.True(codec.TryDecodeForRequest(request with
        {
            QueryText = "CAFE\u0301",
            Statuses = request.Statuses.Reverse().ToArray(),
            Buckets = request.Buckets.Reverse().ToArray(),
            Cursor = value
        }, cursor.Binding, out anchor, out reason));
        Assert.Equal(cursor.Anchor, anchor);
        Assert.Null(reason);
        Assert.True(codec.TryDecodeForRequest(request, cursor.Binding, out anchor, out reason));
        Assert.Null(anchor);
        Assert.Null(reason);
    }

    [Theory]
    [InlineData("principal")]
    [InlineData("site")]
    [InlineData("request-id")]
    [InlineData("sequence")]
    [InlineData("query")]
    [InlineData("diacritics")]
    [InlineData("statuses")]
    [InlineData("buckets")]
    [InlineData("locale")]
    [InlineData("limit")]
    public void RequestCursor_RejectsTransplantedRequestBeforeIssuingOrReadingAnchor(string field)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryRequest request = Request() with
        {
            QueryText = "café"
        };
        AuthorArticleQueryCursor cursor = BoundCursor(request);
        string value = codec.EncodeForRequest(request, cursor);
        AuthorArticleQueryRequest changed = field switch
        {
            "principal" => request with { Owner = new(8, "site-a") },
            "site" => request with { Owner = new(7, "site-b") },
            "request-id" => request with { RequestId = Guid.CreateVersion7() },
            "sequence" => request with { RequestSequence = 2 },
            "query" => request with { QueryText = "other" },
            "diacritics" => request with { QueryText = "cafe" },
            "statuses" => request with { Statuses = [AuthorArticleQueryStatus.Published] },
            "buckets" => request with { Buckets = [AuthorArticleQueryBucket.Published] },
            "locale" => request with { Locale = "en-US" },
            _ => request with { Limit = 20 }
        };
        Assert.Throws<ArgumentException>(() => codec.EncodeForRequest(changed, cursor));
        foreach (string? supplied in new[] { value, null })
        {
            Assert.False(codec.TryDecodeForRequest(changed with
            {
                Cursor = supplied
            }, cursor.Binding,
                out var anchor, out var reason));
            Assert.Null(anchor);
            Assert.Equal("author_article_query_cursor_stale", reason);
        }
    }

    [Theory]
    [InlineData("owner")]
    [InlineData("request")]
    [InlineData("source")]
    [InlineData("history")]
    [InlineData("permission-digest")]
    [InlineData("permission-revision")]
    [InlineData("site")]
    [InlineData("session")]
    public void RequestCursor_CurrentAuthorityDriftCannotExposeAnchor(string field)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryRequest request = Request();
        AuthorArticleQueryCursor cursor = BoundCursor(request);
        AuthorArticleQueryCursorBinding changed = field switch
        {
            "owner" => cursor.Binding with { Owner = new(7, "other-site") },
            "request" => cursor.Binding with { RequestDigest = Hash("changed") },
            "source" => cursor.Binding with { SourceDigest = Hash("changed") },
            "history" => cursor.Binding with { HistoryProjectionDigest = Hash("changed") },
            "permission-digest" => cursor.Binding with { PermissionDigest = Hash("changed") },
            "permission-revision" => cursor.Binding with { PermissionRevision = Hash("changed") },
            "site" => cursor.Binding with { SiteRevision = Hash("changed") },
            _ => cursor.Binding with { SessionRevision = Hash("changed") }
        };
        Assert.False(codec.TryDecodeForRequest(request with
        {
            Cursor = codec.EncodeForRequest(request, cursor)
        },
            changed, out var anchor, out var reason));
        Assert.Null(anchor);
        Assert.Equal("author_article_query_cursor_stale", reason);
    }

    [Theory]
    [InlineData("binding-null")]
    [InlineData("owner-null")]
    [InlineData("owner-invalid")]
    [InlineData("request")]
    [InlineData("source")]
    [InlineData("history")]
    [InlineData("permission-digest")]
    [InlineData("permission-revision")]
    [InlineData("site")]
    [InlineData("session")]
    public void RequestCursor_MalformedLiveBindingCannotAdmitFirstOrLaterPage(string field)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryRequest request = Request();
        AuthorArticleQueryCursor cursor = BoundCursor(request);
        string value = codec.EncodeForRequest(request, cursor);
        AuthorArticleQueryCursorBinding invalid = field switch
        {
            "binding-null" => null!,
            "owner-null" => cursor.Binding with { Owner = null! },
            "owner-invalid" => cursor.Binding with { Owner = new(0, "site-a") },
            "request" => cursor.Binding with { RequestDigest = "invalid" },
            "source" => cursor.Binding with { SourceDigest = "invalid" },
            "history" => cursor.Binding with { HistoryProjectionDigest = "invalid" },
            "permission-digest" => cursor.Binding with { PermissionDigest = "invalid" },
            "permission-revision" => cursor.Binding with { PermissionRevision = "invalid" },
            "site" => cursor.Binding with { SiteRevision = "invalid" },
            _ => cursor.Binding with { SessionRevision = "invalid" }
        };
        foreach (string? supplied in new[] { value, null })
        {
            Assert.False(codec.TryDecode(supplied, invalid, out var anchor, out var reason));
            Assert.Null(anchor);
            Assert.Equal("author_article_query_cursor_invalid", reason);
            Assert.False(codec.TryDecodeForRequest(request with
            {
                Cursor = supplied
            }, invalid,
                out anchor, out reason));
            Assert.Null(anchor);
            Assert.Equal("author_article_query_cursor_invalid", reason);
        }
    }

    [Fact]
    public void RequestCursor_RejectsOriginalHistoryPurposeBeforeExposingAnchor()
    {
        var provider = new EphemeralDataProtectionProvider();
        var codec = new AuthorArticleQueryCursorCodec(provider);
        AuthorArticleQueryRequest request = Request();
        AuthorArticleQueryCursor cursor = BoundCursor(request);
        var history = new AuthorRecentArticleHistoryCursorCodec(provider);
        string historyCursor = history.Encode(new(new(7, "site-a"), 1, Hash("collection"), Hash("permission"),
            Hash("site"), Hash("session"), new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc), 1));
        Assert.False(codec.TryDecodeForRequest(request with
        {
            Cursor = historyCursor
        }, cursor.Binding,
            out var anchor, out var reason));
        Assert.Null(anchor);
        Assert.Equal("author_article_query_cursor_invalid", reason);
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("inbox")]
    [InlineData("collation")]
    [InlineData("limit")]
    [InlineData("request-id")]
    [InlineData("sequence")]
    public void RequestCursor_PreservesOriginalRequestAndInboxRefusals(string field)
    {
        var codec = new AuthorArticleQueryCursorCodec(new EphemeralDataProtectionProvider());
        AuthorArticleQueryRequest request = Request();
        AuthorArticleQueryCursor cursor = BoundCursor(request);
        AuthorArticleQueryRequest invalid = field switch
        {
            "schema" => request with { SchemaVersion = 2 },
            "inbox" => request with { Buckets = [AuthorArticleQueryBucket.Inbox] },
            "collation" => request with { Collation = "other" },
            "limit" => request with { Limit = AuthorArticleQueryContract.MaxLimit + 1 },
            "request-id" => request with { RequestId = Guid.Empty },
            _ => request with { RequestSequence = 0 }
        };
        if (field == "inbox")
        {
            Assert.Throws<NotSupportedException>(() => codec.EncodeForRequest(invalid, cursor));
            Assert.Throws<NotSupportedException>(() =>
            {
                codec.TryDecodeForRequest(invalid, cursor.Binding, out _, out _);
            });
        }
        else
        {
            Assert.Throws<ArgumentException>(() => codec.EncodeForRequest(invalid, cursor));
            Assert.Throws<ArgumentException>(() =>
            {
                codec.TryDecodeForRequest(invalid, cursor.Binding, out _, out _);
            });
        }
    }

    private static AuthorArticleQueryCursor BoundCursor(AuthorArticleQueryRequest request)
    {
        AuthorArticleQueryCursor cursor = Cursor();
        return cursor with
        {
            Binding = cursor.Binding with
            {
                Owner = request.Owner,
                RequestDigest = AuthorArticleQueryCursorCodec.ComputeRequestDigest(request)
            }
        };
    }

    private static AuthorArticleQueryCursor Cursor()
        => new(1, AuthorArticleQueryRanking.RankingId,
            new(new(7, "site-a"), AuthorArticleQueryCursorCodec.ComputeRequestDigest(Request()), Hash("source"),
                Hash("history"), Hash("decisions"), Hash("permission"), Hash("site"), Hash("session")),
            new(0, 0, 3, int.MaxValue, 3, int.MaxValue, 0, 1));

    private static string Hash(string value) => AuthorRecentArticleHistoryContract.HashText(value);
}
