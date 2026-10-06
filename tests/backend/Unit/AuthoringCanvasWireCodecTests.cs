using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "GoldenContract")]
public sealed class AuthoringCanvasWireCodecTests
{
    [Fact]
    public async Task Preparation_UsesActualResolverValidatorAndPlanner()
        => Assert.Equal(18, await Fixtures.AuthoringCanvasPreparationControls.RunAsync());

    public static IEnumerable<object[]> WireCases()
    {
        using JsonDocument golden = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "tests/fixtures/protocol/authoring-canvas-wire-golden.json"));
        using JsonDocument schema = JsonDocument.Parse(BackendTestPaths.ReadAllTextFromRoot(
            "src/shared/Contracts/Validation/authoring-canvas-wire.json"));
        Dictionary<int, string> roots = schema.RootElement.GetProperty("roots").EnumerateArray()
            .ToDictionary(static root => root.GetProperty("frameType").GetInt32(),
                static root => root.GetProperty("type").GetString()!);
        return golden.RootElement.GetProperty("cases").EnumerateArray()
            .Select(row => new object[]
            {
                row.GetProperty("name").GetString()!,
                roots[row.GetProperty("frameType").GetInt32()],
                row.GetProperty("payloadHex").GetString()!,
                row.GetProperty("valid").GetBoolean()
            }).ToArray();
    }

    [Theory]
    [MemberData(nameof(WireCases))]
    public void CrossStackGolden_UsesActualCodecAndExactBytes(
        string name, string rootType, string payloadHex, bool expectedValid)
    {
        byte[] bytes = Convert.FromHexString(payloadHex);
        MethodInfo decode = typeof(PodBinaryCodec).GetMethod("TryDecode" + rootType)!;
        Assert.NotNull(decode);
        object?[] arguments = [new ReadOnlyMemory<byte>(bytes), null];
        bool valid = (bool)decode.Invoke(null, arguments)!;
        Assert.True(valid == expectedValid, name);
        if (valid)
        {
            MethodInfo encode = typeof(PodBinaryCodec).GetMethod("Encode" + rootType)!;
            Assert.NotNull(encode);
            byte[] encoded = (byte[])encode.Invoke(null, [arguments[1]])!;
            Assert.Equal(bytes, encoded);
        }
    }
}
