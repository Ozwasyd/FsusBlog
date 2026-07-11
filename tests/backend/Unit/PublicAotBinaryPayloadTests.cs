using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBinaryPayloadTests
{
    [Fact]
    public void StringPayload_RoundTripsEmptyUnicodeAndNestedValues()
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["empty"] = string.Empty,
            ["unicode"] = "标题🙂/uploads/illustration/html image.jpg",
            ["nested"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["text"] = "line\nbreak"
            }
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal(string.Empty, decoded["empty"]);
        Assert.Equal("标题🙂/uploads/illustration/html image.jpg", decoded["unicode"]);
        var nested = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(decoded["nested"]);
        Assert.Equal("line\nbreak", nested["text"]);
    }

    [Fact]
    public void DecimalPayload_RoundTripsWithoutPrecisionOrSignDrift()
    {
        const decimal scoreWeight = 0.1234567890123456789012345678m;
        const decimal negativeFloor = -0.0000000000000000000000000001m;
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["scoreWeight"] = scoreWeight,
            ["negativeFloor"] = negativeFloor,
            ["nested"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["max"] = decimal.MaxValue
            }
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal(scoreWeight, Assert.IsType<decimal>(decoded["scoreWeight"]));
        Assert.Equal(negativeFloor, Assert.IsType<decimal>(decoded["negativeFloor"]));
        var nested = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(decoded["nested"]);
        Assert.Equal(decimal.MaxValue, Assert.IsType<decimal>(nested["max"]));
    }
}
