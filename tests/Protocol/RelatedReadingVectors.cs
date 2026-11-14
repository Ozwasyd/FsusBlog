using FsusBlog.V2.Contracts;

internal static class RelatedReadingVectors
{
    internal static void Run(string fixtures)
    {
        var related = new RelatedReading(
            [Item(10, 1779019200000, "AEDS public reads", "Binary contract", "同分类"),
             Item(11, 1779105600000, "Hydration notes", null, "全文关键词")],
            Item(9, 1778932800000, "Previous article", "previous summary", "上一篇"),
            Item(12, 1779192000000, "Next article", null, "下一篇"));
        var path = Path.Combine(fixtures, "article-related-reading-v1.hex");
        var source = Convert.FromHexString(string.Concat(File.ReadAllLines(path)));
        if (!source.AsSpan().SequenceEqual(RelatedReadingWire.Encode(related)))
            throw new InvalidOperationException("Related reading writer differs from the pinned v1 frame");

        var payload = Aeds.Decode(RelatedReadingWire.Encode(new([], null, null)), FrameType.ArticleRelatedReading);
        if (payload.Length != 12 || payload.ContainsAnyExcept((byte)0))
            throw new InvalidOperationException("Related reading valid-empty response is malformed");
    }

    private static RelatedItem Item(int id, long createdAt, string title, string? summary, string reason) =>
        new(id, DateTimeOffset.FromUnixTimeMilliseconds(createdAt), title, summary, reason);
}
