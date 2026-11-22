using System.Buffers.Binary;
using FsusBlog.V2.Contracts;

internal static class ArticleHotVectors
{
    internal static void Run(string directory)
    {
        // Independent literal AEDS v2 vectors from the frozen ArticleHot POD layout.
        var frame = VectorFixture.Hex(directory, "article-hot-v1.hex");
        ArticleHotItem[] expected =
        [
            new(42, 0, "雪 🐈"),
            new(7, int.MaxValue, ""),
            new(19, 9, "\uFEFFCafe\u0301"),
        ];
        if ((int)FrameType.ArticleHot != 3 || WireRoutes.PublicArticleHot != "/api/binary/article/hot/{size}.aeds" ||
            !frame.AsSpan().SequenceEqual(ArticleHotWire.Encode(expected)) || !expected.SequenceEqual(ArticleHotWire.Decode(frame)))
            throw new InvalidOperationException("ArticleHot differs from the frozen vector");
        var empty = VectorFixture.Hex(directory, "article-hot-empty-v1.hex");
        if (!empty.AsSpan().SequenceEqual(ArticleHotWire.Encode([])) || ArticleHotWire.Decode(empty).Length != 0)
            throw new InvalidOperationException("ArticleHot empty vector differs");

        var title = new string('界', 84) + "🐈";
        var maximum = Enumerable.Range(1, 100).Select(id => new ArticleHotItem(id, 0, title)).ToArray();
        if (!maximum.SequenceEqual(ArticleHotWire.Decode(ArticleHotWire.Encode(maximum))))
            throw new InvalidOperationException("ArticleHot maximum title or count failed");
        Reject(() => ArticleHotWire.Encode([.. maximum, new(101, 0, "")]));
        Reject(() => ArticleHotWire.Encode([new(1, 0, title + "a")]));
        Reject(() => ArticleHotWire.Encode([new(1, 0, "\uD800")]));
        Reject(() => ArticleHotWire.Encode([new(1, -1, "")]));
        Reject(() => ArticleHotWire.Encode([new(0, 0, "")]));
        Reject(() => ArticleHotWire.Encode([new(1, 0, ""), new(1, 0, "")]));

        var payload = Aeds.Decode(frame, FrameType.ArticleHot).ToArray();
        var recordsAt = 8 + 17;
        foreach (var (at, value) in new[]
        {
            (0, -1), (0, 101), (4, -1), (4, int.MaxValue), (recordsAt, 0), (recordsAt + 4, -1),
            (recordsAt + 8, 1), (recordsAt + 12, 257), (recordsAt + 16, 42), (recordsAt + 32 + 12, 0),
        })
        {
            var malformed = payload.ToArray();
            BinaryPrimitives.WriteInt32LittleEndian(malformed.AsSpan(at), value);
            Reject(() => ArticleHotWire.Decode(Aeds.Encode(FrameType.ArticleHot, malformed)));
        }
        Reject(() => ArticleHotWire.Decode(Aeds.Encode(FrameType.ArticleList, payload)));
        Reject(() => ArticleHotWire.DecodePayload(payload[..^1]));
        Reject(() => ArticleHotWire.DecodePayload([.. payload, 0]));
        payload[8] = 0xff;
        Reject(() => ArticleHotWire.DecodePayload(payload));
    }

    private static void Reject(Action decode) =>
        ProtocolRejection.Assert(decode, "Malformed ArticleHot was accepted");
}
