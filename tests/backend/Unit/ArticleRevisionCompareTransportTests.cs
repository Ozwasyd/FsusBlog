using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services.Authoring;

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

    [Theory]
    [InlineData(long.MaxValue)]
    [InlineData(long.MinValue)]
    [InlineData(9007199254740993L)]
    [InlineData(638961048000000001L)]
    public void MetadataValueSerialization_PreservesInt64AndSemanticReceipt(long number)
    {
        // Typed serialization control, not a sealed service or runtime acceptance fixture.
        RevisionMetadataDiffResult result = Metadata(number, "\"\n\\<字段>\u0001");
        ArticleRevisionMetadataDiffResponse response = ArticleRevisionMetadataDiffResponse.From(result)!;
        Assert.Same(result.Receipt, response.Receipt);
        using JsonDocument payload = JsonDocument.Parse(JsonSerializer.Serialize(response, s_options));
        JsonElement before = payload.RootElement.GetProperty("fields")[0].GetProperty("before");
        Assert.Equal(JsonValueKind.String, before.GetProperty("number").ValueKind);
        Assert.Equal(number.ToString(System.Globalization.CultureInfo.InvariantCulture), before.GetProperty("number").GetString());
        Assert.Equal(JsonValueKind.String, payload.RootElement.GetProperty("timing").GetProperty("elapsedTicks").ValueKind);
        Assert.Equal(long.MaxValue.ToString(System.Globalization.CultureInfo.InvariantCulture),
            payload.RootElement.GetProperty("timing").GetProperty("elapsedTicks").GetString());
        Assert.False(payload.RootElement.GetProperty("isSuccess").GetBoolean());
        Assert.True(payload.RootElement.GetProperty("isReviewable").GetBoolean());
        Assert.Equal(JsonValueKind.Null, payload.RootElement.GetProperty("fields")[0].GetProperty("after").GetProperty("number").ValueKind);
        long actualBytes = JsonSerializer.SerializeToUtf8Bytes(response, s_options).LongLength;
        Assert.True(actualBytes <= RevisionMetadataDiffEngine.EstimateOutputBytes(result.Receipt, result.Fields));
    }

    [Fact]
    public void MetadataWireEstimator_CoversEscapedTextIdsAndDecimalQuotes()
    {
        RevisionMetadataDiffResult result = Metadata(long.MinValue, string.Concat(Enumerable.Repeat("\u0001\"\\<字段>\n", 4096)));
        byte[] wire = JsonSerializer.SerializeToUtf8Bytes(ArticleRevisionMetadataDiffResponse.From(result), s_options);
        Assert.True(wire.LongLength <= RevisionMetadataDiffEngine.EstimateOutputBytes(result.Receipt, result.Fields));
        using JsonDocument payload = JsonDocument.Parse(wire);
        Assert.Equal(result.Fields[0].After.Text, payload.RootElement.GetProperty("fields")[0].GetProperty("after").GetProperty("text").GetString());
        Assert.False(payload.RootElement.TryGetProperty("bundle", out _));
        Assert.False(payload.RootElement.TryGetProperty("reader", out _));
        Assert.Null(ArticleRevisionMetadataDiffResponse.From(null));
    }

    private static RevisionMetadataDiffResult Metadata(long number, string text)
        => new(new("serialization-control", "serialization-control", new string('a', 64),
                RevisionMetadataDiffStatus.PartialMissingAuthority, RevisionMetadataDiffCoverage.PartialMissingAuthority,
                "metadata_diff_missing_authority", new string('b', 64), new string('c', 64), new string('d', 64), 1,
                ["historical_lifecycle_missing_authority"], new string('e', 64)),
            [new("typed-value", new string('c', 64), new string('d', 64), "serialization-control", "exact", "plain-text", false,
                new(RevisionMetadataDiffValueKind.Integer, Number: number, Ids: [int.MinValue, int.MaxValue]),
                new(RevisionMetadataDiffValueKind.String, Text: text), RevisionMetadataDiffChangeKind.Replaced,
                [int.MaxValue], [int.MinValue])],
            new(long.MaxValue, 1000000000L));
}
