using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleRevisionCompareTransportTests
{
    private static readonly JsonSerializerOptions s_options = new(JsonSerializerDefaults.Web);

    [Fact]
    public void CompareRoute_UsesDedicatedFramesOnTheExistingAuthoringBoundary()
    {
        Assert.True(AuthoringEndpoints.TryResolveRoute(HttpMethods.Post,
            new PathString("/articles/1/revisions/compare"), out var route));
        Assert.Equal(AedsFrameType.ArticleRevisionCompareRequest, route.RequestFrame);
        Assert.Equal(AedsFrameType.ArticleRevisionCompareResponse, route.ResponseFrame);
    }

    [Fact]
    public void DraftCoordinateRoute_UsesDedicatedFramesOnTheExistingAuthoringBoundary()
    {
        Assert.True(AuthoringEndpoints.TryResolveRoute(HttpMethods.Post,
            new PathString("/articles/1/revisions/compare/draft-coordinate"), out var route));
        Assert.Equal(AedsFrameType.ArticleRevisionCompareDraftCoordinateRequest, route.RequestFrame);
        Assert.Equal(AedsFrameType.ArticleRevisionCompareDraftCoordinateResponse, route.ResponseFrame);
    }

    [Fact]
    public void DraftCoordinateRequest_RejectsClientReaderAndNumericServerRevision()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ArticleRevisionCompareDraftCoordinateRequest>(
            "{\"draftKey\":\"draft-1\",\"expectedServerRevision\":\"1\",\"reader\":{\"adminPrincipalId\":1}}", s_options));
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ArticleRevisionCompareDraftCoordinateRequest>(
            "{\"draftKey\":\"draft-1\",\"expectedServerRevision\":9007199254740993}", s_options));
    }

    [Theory]
    [InlineData("9007199254740993", 9007199254740993L)]
    [InlineData("9223372036854775807", long.MaxValue)]
    public void Selector_PreservesInt64WithoutJavaScriptNumberCoercion(string value, long expected)
    {
        var selector = new ArticleRevisionCompareSelector(RevisionCompareSourceKind.HistoricalRevision, value);
        Assert.Equal(expected, selector.ToSelector().RevisionId);
        var reference = new RevisionComparePackageReference(RevisionCompareSourceKind.HistoricalRevision,
            "revision:" + value, expected, 1, null, null, new string('a', 64), new string('b', 64), 5);
        using JsonDocument payload = JsonDocument.Parse(JsonSerializer.Serialize(
            ArticleRevisionComparePackageReference.From(reference), s_options));
        Assert.Equal(JsonValueKind.String, payload.RootElement.GetProperty("revisionId").ValueKind);
        Assert.Equal(value, payload.RootElement.GetProperty("revisionId").GetString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("0")]
    [InlineData("01")]
    [InlineData("-1")]
    [InlineData("1e3")]
    [InlineData(" 1")]
    [InlineData("9223372036854775808")]
    public void Selector_RejectsNonCanonicalOrOverflowingCoordinates(string value)
    {
        var selector = new ArticleRevisionCompareSelector(RevisionCompareSourceKind.HistoricalRevision, value);
        Assert.Throws<RevisionCompareContractException>(() => selector.ToSelector());
    }

    [Fact]
    public void Request_RejectsClientReaderAuthority()
    {
        const string payload = """
            {"base":{"kind":1,"revisionId":"1"},"compare":{"kind":2,"revisionId":"2"},
             "options":{"viewMode":0,"wordSegmentation":0,"contextLineCount":3,"headingNavigation":false,"metadataFieldIds":[]},
             "budgets":{},"cancellationIdentity":"action-1",
             "reader":{"adminPrincipalId":1,"siteScope":"other","requestId":"00000000-0000-0000-0000-000000000001"}}
            """;
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ArticleRevisionCompareRequest>(payload, s_options));
    }

    [Fact]
    public void Selector_RejectsNumericWireCoordinates()
    {
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<ArticleRevisionCompareSelector>(
            "{\"kind\":2,\"revisionId\":9007199254740993}", s_options));
    }
}
