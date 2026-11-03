using System.Text.Json;

using FsusBlog.Contracts.AuthoringNavigation;
using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class AuthorArticleSelectionWireTests
{
    public static IEnumerable<object[]> WireCases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/author-article-selection-wire-golden.json"));
        return golden.RootElement.GetProperty("cases").EnumerateArray().Select(row => new object[]
        {
            row.GetProperty("name").GetString()!, row.GetProperty("frameType").GetInt32(),
            row.GetProperty("payloadHex").GetString()!, row.GetProperty("valid").GetBoolean()
        }).ToArray();
    }

    [Theory]
    [MemberData(nameof(WireCases))]
    public void LiteralGoldens_UseActualClosedCodec(string name, int frameType, string hex, bool expected)
    {
        byte[] bytes = Convert.FromHexString(hex);
        if (frameType == 276)
        {
            bool valid = PodBinaryCodec.TryDecodeAuthorArticleSelectionRevalidationRequest(bytes, out var value);
            Assert.True(valid == expected, name);
            if (valid)
            {
                Assert.Equal(long.MaxValue, value.ServerRevision);
                Assert.Equal(Guid.Parse("018f1ce7-093a-7a01-bbcc-123456789abc"), value.RequestId);
                Assert.Equal(bytes, PodBinaryCodec.EncodeAuthorArticleSelectionRevalidationRequest(value));
            }
        }
        else
        {
            Assert.Equal(277, frameType);
            bool valid = PodBinaryCodec.TryDecodeAuthorArticleSelectionRevalidationResponse(bytes, out var value);
            Assert.True(valid == expected, name);
            if (valid)
            {
                Assert.Equal(long.MaxValue, value.Owner.AdminPrincipalId);
                Assert.Equal(long.MaxValue, value.ServerRevision);
                Assert.Equal(bytes, PodBinaryCodec.EncodeAuthorArticleSelectionRevalidationResponse(value));
            }
        }
    }

    [Fact]
    public void EveryTruncation_OversizeAndMalformedEncoderInputRefuse()
    {
        foreach (object[] row in WireCases().Where(static row => (bool)row[3]))
        {
            byte[] payload = Convert.FromHexString((string)row[2]);
            for (int end = 0; end < payload.Length; end++)
            {
                if ((int)row[1] == 276)
                    Assert.False(PodBinaryCodec.TryDecodeAuthorArticleSelectionRevalidationRequest(payload.AsMemory(0, end), out _));
                else
                    Assert.False(PodBinaryCodec.TryDecodeAuthorArticleSelectionRevalidationResponse(payload.AsMemory(0, end), out _));
            }
        }
        Assert.False(PodBinaryCodec.TryDecodeAuthorArticleSelectionRevalidationResponse(new byte[627], out _));
        var request = new AuthorArticleSelectionRevalidationRequest(1, 1, long.MaxValue, Guid.NewGuid(), new string('a', 64));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeAuthorArticleSelectionRevalidationRequest(request with { SchemaVersion = 2 }));
        var response = new AuthorArticleSelectionRevalidationResponse(1, true, new(1, "primary"),
            request.ArticleId, request.ServerRevision, request.RequestId, request.PermissionToken);
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeAuthorArticleSelectionRevalidationResponse(response with
        {
            Owner = response.Owner with
            {
                SiteScope = "site\ud800"
            }
        }));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeAuthorArticleSelectionRevalidationResponse(response with { Current = false }));
    }
}
