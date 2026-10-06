using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class ArticleCanvasLinkWireCodecTests
{
    public static IEnumerable<object[]> WireCases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/article-canvas-link-wire-golden.json"));
        string[] roots = ["ArticleCanvasLinkRequest", "ArticleCanvasLinkReceipt", "ArticleCanvasLinkHistoryResponse"];
        return golden.RootElement.GetProperty("cases").EnumerateArray().Select(row => new object[]
        {
            row.GetProperty("name").GetString()!, roots[row.GetProperty("frameType").GetInt32() - 266],
            row.GetProperty("payloadHex").GetString()!, row.GetProperty("valid").GetBoolean()
        }).ToArray();
    }

    [Theory]
    [MemberData(nameof(WireCases))]
    public void ActualCodec_ConsumesExactWireWitness(string name, string rootType, string hex, bool expectedValid)
    {
        byte[] bytes = Convert.FromHexString(hex);
        MethodInfo decode = typeof(PodBinaryCodec).GetMethod("TryDecode" + rootType)!;
        object?[] arguments = [new ReadOnlyMemory<byte>(bytes), null];
        Assert.True(expectedValid == (bool)decode.Invoke(null, arguments)!, name);
        if (expectedValid)
        {
            MethodInfo encode = typeof(PodBinaryCodec).GetMethod("Encode" + rootType)!;
            Assert.Equal(bytes, (byte[])encode.Invoke(null, [arguments[1]])!);
        }
    }
}
