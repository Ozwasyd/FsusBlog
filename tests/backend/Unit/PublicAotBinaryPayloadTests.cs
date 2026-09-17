using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBinaryPayloadTests
{
    private enum PayloadState
    {
        Ready
    }

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
        const decimal ScoreWeight = 0.1234567890123456789012345678m;
        const decimal NegativeFloor = -0.0000000000000000000000000001m;
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["scoreWeight"] = ScoreWeight,
            ["negativeFloor"] = NegativeFloor,
            ["nested"] = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["max"] = decimal.MaxValue
            }
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal(ScoreWeight, Assert.IsType<decimal>(decoded["scoreWeight"]));
        Assert.Equal(NegativeFloor, Assert.IsType<decimal>(decoded["negativeFloor"]));
        var nested = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(decoded["nested"]);
        Assert.Equal(decimal.MaxValue, Assert.IsType<decimal>(nested["max"]));
    }

    [Fact]
    public void EnumPayload_RoundTripsAsStableName()
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["state"] = PayloadState.Ready
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal(nameof(PayloadState.Ready), decoded["state"]);
    }

    [Fact]
    public void DatabaseTimestamp_RoundTripsAsUtcWithoutHostTimezoneShift()
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["updatedAt"] = new DateTime(2026, 7, 17, 0, 56, 33, DateTimeKind.Unspecified)
        };

        byte[] frame = PublicAotBinaryPayload.EncodeObjectFrame(payload);

        Assert.True(PublicAotBinaryPayload.TryDecodeObject(frame, out Dictionary<string, object?> decoded));
        Assert.Equal("2026-07-17T00:56:33.0000000Z", decoded["updatedAt"]);
    }
}
