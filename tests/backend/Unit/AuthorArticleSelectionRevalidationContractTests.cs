using FsusBlog.Contracts.AuthoringNavigation;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthorArticleSelectionRevalidationContractTests
{
    private static readonly Guid s_requestId = Guid.Parse("018f1ce7-093a-7a01-bbcc-123456789abc");
    private static AuthorArticleSelectionRevalidationRequest Request()
        => new(1, 27, long.MaxValue, s_requestId, new string('a', 64));
    private static AuthorArticleSelectionRevalidationResponse Response(bool current = true)
        => new(1, current, new(long.MaxValue, "https://actual-site.example"), 27, long.MaxValue,
            s_requestId, current ? new string('a', 64) : null);

    [Fact]
    public void Request_CannotCarryOwnerAndInt64CoordinatesRemainLossless()
    {
        Assert.Equal(new[] { "ArticleId", "PermissionToken", "RequestId", "SchemaVersion", "ServerRevision" },
            typeof(AuthorArticleSelectionRevalidationRequest).GetProperties().Select(static p => p.Name).Order().ToArray());
        Assert.True(AuthorArticleSelectionRevalidationContract.IsValidRequest(Request()));
        Assert.True(AuthorArticleSelectionRevalidationContract.MatchesRequest(Request(), Response()));
        Assert.Equal(long.MaxValue, Response().Owner.AdminPrincipalId);
        Assert.Equal(long.MaxValue, Request().ServerRevision);
    }

    [Theory]
    [InlineData("schema")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("request")]
    [InlineData("token-null")]
    [InlineData("token-short")]
    [InlineData("token-upper")]
    [InlineData("token-space")]
    public void Request_RejectsInvalidIdentityVersionOrToken(string fault)
    {
        AuthorArticleSelectionRevalidationRequest request = Request();
        request = fault switch
        {
            "schema" => request with { SchemaVersion = 2 },
            "article" => request with { ArticleId = 0 },
            "revision" => request with { ServerRevision = 0 },
            "request" => request with { RequestId = Guid.Empty },
            "token-null" => request with { PermissionToken = null! },
            "token-short" => request with { PermissionToken = new string('a', 63) },
            "token-upper" => request with { PermissionToken = new string('A', 64) },
            _ => request with { PermissionToken = new string('a', 63) + " " }
        };
        Assert.False(AuthorArticleSelectionRevalidationContract.IsValidRequest(request));
        Assert.False(AuthorArticleSelectionRevalidationContract.MatchesRequest(request, Response()));
    }

    [Theory]
    [InlineData("owner-null")]
    [InlineData("principal")]
    [InlineData("scope-empty")]
    [InlineData("scope-size")]
    [InlineData("scope-trim")]
    [InlineData("scope-control")]
    [InlineData("schema")]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("request")]
    [InlineData("token-null")]
    [InlineData("denial-token")]
    public void Response_RejectsInvalidOwnerCoordinateOrDisclosure(string fault)
    {
        AuthorArticleSelectionRevalidationResponse response = Response();
        response = fault switch
        {
            "owner-null" => response with { Owner = null! },
            "principal" => response with { Owner = response.Owner with { AdminPrincipalId = 0 } },
            "scope-empty" => response with { Owner = response.Owner with { SiteScope = "" } },
            "scope-size" => response with { Owner = response.Owner with { SiteScope = new string('x', 129) } },
            "scope-trim" => response with { Owner = response.Owner with { SiteScope = " site " } },
            "scope-control" => response with { Owner = response.Owner with { SiteScope = "site\nvalue" } },
            "schema" => response with { SchemaVersion = 2 },
            "article" => response with { ArticleId = 0 },
            "revision" => response with { ServerRevision = 0 },
            "request" => response with { RequestId = Guid.Empty },
            "token-null" => response with { PermissionToken = null },
            _ => response with { Current = false }
        };
        Assert.False(AuthorArticleSelectionRevalidationContract.IsValidResponse(response));
        Assert.False(AuthorArticleSelectionRevalidationContract.MatchesRequest(Request(), response));
    }

    [Theory]
    [InlineData("article")]
    [InlineData("revision")]
    [InlineData("request")]
    [InlineData("permission")]
    public void ValidButForeignObservation_CannotCorrelate(string fault)
    {
        AuthorArticleSelectionRevalidationResponse response = Response();
        response = fault switch
        {
            "article" => response with { ArticleId = 28 },
            "revision" => response with { ServerRevision = long.MaxValue - 1 },
            "request" => response with { RequestId = Guid.Parse("018f1ce7-093a-7a01-bbcc-123456789abd") },
            _ => response with { PermissionToken = new string('b', 64) }
        };
        Assert.True(AuthorArticleSelectionRevalidationContract.IsValidResponse(response));
        Assert.False(AuthorArticleSelectionRevalidationContract.MatchesRequest(Request(), response));
    }

    [Fact]
    public void Denial_DropsPermissionTokenButRetainsRequestCorrelationWithoutGrant()
    {
        Assert.True(AuthorArticleSelectionRevalidationContract.IsValidResponse(Response(false)));
        Assert.True(AuthorArticleSelectionRevalidationContract.MatchesRequest(Request(), Response(false)));
        Assert.False(Response(false).Current);
        Assert.Null(Response(false).PermissionToken);
        Assert.False(AuthorArticleSelectionRevalidationContract.IsValidRequest(null));
        Assert.False(AuthorArticleSelectionRevalidationContract.IsValidResponse(null));
        Assert.False(AuthorArticleSelectionRevalidationContract.MatchesRequest(Request(), null));
    }
}
