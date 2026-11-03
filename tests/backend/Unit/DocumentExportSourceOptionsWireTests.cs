using FsusBlog.Core.Cache;

using FsusBlog.Shared.Contracts.DocumentExport;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DocumentExportSourceOptionsWireTests
{
    private static DocumentExportSourceSelector Revision() => new(2, 42, null, 17, null);
    private static DocumentExportSourceChoicesResponse Choices() => new([
        new(new string('a', 64), "原始标题 🌍", new(2, 42, null, 17, null, 9007199254740993))
    ]);

    [Theory]
    [InlineData("capture-revision", "0100000001000000020000002a0000000001110000000000000000")]
    [InlineData("revision-choices", "010000002a000000")]
    [InlineData("empty-choices", "0100000000000000")]
    [InlineData("exact-version-choices", "0100000001000000400000006161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616111000000e58e9fe5a78be6a087e9a29820f09f8c8d020000002a0000000000000000011100000000000000000100000000002000")]
    public void LiteralGoldens_AllRootsRefuseTruncationAndTrailingBytes(string name, string hex)
    {
        byte[] expected = Convert.FromHexString(hex);
        byte[] actual = name switch
        {
            "capture-revision" => PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([Revision()])),
            "revision-choices" => PodBinaryCodec.EncodeDocumentExportRevisionChoicesRequest(new(42)),
            "empty-choices" => PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(new([])),
            _ => PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(Choices())
        };
        Assert.Equal(expected, actual);
        Assert.True(Decode(name, expected));
        for (int count = 0; count < expected.Length; count++)
        {
            Assert.False(Decode(name, expected.AsMemory(0, count)));
        }
        byte[] trailing = [.. expected, 0];
        Assert.False(Decode(name, trailing));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public void Selector_PreservesOnlyTheKindSpecificUnboundIntent(int kind)
    {
        DocumentExportSourceSelector source = kind switch
        {
            1 => new(1, 42, "草稿-🌍", null, null),
            2 => Revision(),
            _ => Revision() with { Kind = 3, PublicationId = long.MaxValue }
        };
        byte[] payload = PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([source]));
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportSourceCaptureRequest(payload, out var actual));
        Assert.Equal(source, Assert.Single(actual.Sources));
    }

    [Fact]
    public void Choices_PreserveIndependentFullInt64SourceVersion()
    {
        byte[] payload = PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(Choices());
        Assert.True(PodBinaryCodec.TryDecodeDocumentExportSourceChoicesResponse(payload, out var actual));
        var choice = Assert.Single(actual.Choices);
        Assert.Equal(9007199254740993, choice.Coordinate.SourceVersion);
        Assert.Equal(17, choice.Coordinate.RevisionId);
        Assert.Equal(new string('a', 64), choice.ChoiceId);
    }

    [Fact]
    public void Writers_RefuseMixedCoordinatesDuplicatesAndOverFifty()
    {
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([Revision(), Revision()])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([Revision() with { DraftKey = "mixed" }])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new(
            Enumerable.Range(1, 51).Select(id => Revision() with { ArticleId = id }).ToArray())));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(new([Choices().Choices[0], Choices().Choices[0]])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportRevisionChoicesRequest(new(0)));
    }

    [Fact]
    public void DisplayProjection_HasNoPrivateBindingsOrSourceContent()
    {
        Assert.Equal(["ChoiceId", "Coordinate", "Label"], typeof(DocumentExportSourceChoiceResponse)
            .GetProperties().Select(property => property.Name).Order(StringComparer.Ordinal));
        Assert.Equal(["ArticleId", "DraftKey", "Kind", "PublicationId", "RevisionId"], typeof(DocumentExportSourceSelector)
            .GetProperties().Select(property => property.Name).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void PersistedStringBounds_RefuseUnpairedSurrogatesWithoutTruncation()
    {
        var choice = Choices().Choices[0];
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(new([choice with { Label = new string('界', 257) }])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceChoicesResponse(new([choice with { Label = "\ud800" }])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([new(1, 42, "\u0085draft", null, null)])));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeDocumentExportSourceCaptureRequest(new([new(1, 42, new string('界', 97), null, null)])));
    }

    private static bool Decode(string name, ReadOnlyMemory<byte> payload) => name switch
    {
        "capture-revision" => PodBinaryCodec.TryDecodeDocumentExportSourceCaptureRequest(payload, out _),
        "revision-choices" => PodBinaryCodec.TryDecodeDocumentExportRevisionChoicesRequest(payload, out _),
        _ => PodBinaryCodec.TryDecodeDocumentExportSourceChoicesResponse(payload, out _)
    };
}
