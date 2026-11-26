internal static class VectorFixture
{
    internal static byte[] Hex(string directory, string file) =>
        Convert.FromHexString(File.ReadAllText(Path.Combine(directory, file)).Trim());

    internal static byte[] MultilineHex(string directory, string file) =>
        Convert.FromHexString(string.Concat(File.ReadAllLines(Path.Combine(directory, file))));

    internal static byte[] HexBytes(string hex) => Convert.FromHexString(hex);

    internal static string HexLower(ReadOnlySpan<byte> bytes) => Convert.ToHexStringLower(bytes);

    internal static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual, string message = "AEDS bytes differ from independent vector")
    {
        if (!expected.SequenceEqual(actual)) throw new InvalidOperationException(message);
    }

    internal static void CheckHex(string directory, string file, ReadOnlySpan<byte> actual, string message = "AEDS bytes differ from independent vector") =>
        Equal(Hex(directory, file), actual, message);

    internal static void CheckMultilineHex(string directory, string file, ReadOnlySpan<byte> actual, string message = "AEDS bytes differ from independent vector") =>
        Equal(MultilineHex(directory, file), actual, message);

    internal static void CheckRoundTrip<T>(byte[] expected, T value, Func<T, byte[]> encode, Func<byte[], T> decode, string message = "AEDS round-trip mismatch")
    {
        Equal(expected, encode(value), message);
        Require(EqualityComparer<T>.Default.Equals(decode(expected), value), message);
    }

    internal static byte[] WithByte(ReadOnlySpan<byte> bytes, int offset, byte value)
    {
        var copy = bytes.ToArray();
        copy[offset] = value;
        return copy;
    }

    internal static byte[] WithI32(ReadOnlySpan<byte> bytes, int offset, int value)
    {
        var copy = bytes.ToArray();
        BinaryPrimitives.WriteInt32LittleEndian(copy.AsSpan(offset), value);
        return copy;
    }

    internal static byte[] WithI64(ReadOnlySpan<byte> bytes, int offset, long value)
    {
        var copy = bytes.ToArray();
        BinaryPrimitives.WriteInt64LittleEndian(copy.AsSpan(offset), value);
        return copy;
    }

    internal static void Require(bool condition, string message = "Vector assertion failed")
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    internal static void CheckSearchTotals(string label, ArticleSearchDetailedPage expected, ArticleSearchDetailedPage actual)
    {
        var expectedCounts = (expected.Total, expected.PrimaryTotal, expected.RelaxedTotal);
        var actualCounts = (actual.Total, actual.PrimaryTotal, actual.RelaxedTotal);
        Require(expectedCounts == actualCounts, $"[{label}] counts expected={expectedCounts} actual={actualCounts}");
    }

    internal static void CheckSearchHits(string label, ReadOnlySpan<ArticleSearchHit> expected, ReadOnlySpan<ArticleSearchHit> actual, double tolerance)
    {
        Require(expected.Length == actual.Length,
            $"[{label}] hit length expected={expected.Length} actual={actual.Length}");
        for (var i = 0; i < expected.Length; i++)
        {
            var e = expected[i];
            var a = actual[i];
            Require(e.Article.Id == a.Article.Id && e.Tier == a.Tier && Math.Abs(e.Score - a.Score) <= tolerance,
                $"[{label}] hit[{i}] expected=({e.Article.Id},{e.Tier},{e.Score:R}) actual=({a.Article.Id},{a.Tier},{a.Score:R})");
        }
    }

    internal static void CheckSearchCursorWalk(string label, ArticleSearchIndex index, ArticleSearchDetailedPage oracle,
        string query, ArticleSearchSort sort, int pageSize, int maxContinuedPages, bool checkLowerBoundTierSum)
    {
        var walked = new List<ArticleSearchHit>();
        SearchCursorPosition? cursor = null;
        for (var pageNumber = 1; ; pageNumber++)
        {
            var page = index.SearchWithCursor(query, sort, pageSize, cursor, walked.Count, CancellationToken.None, out var stats);
            Require(page.TotalCount >= page.Hits.Length, $"[{label}] p{pageNumber} TotalCount < Hits.Length");
            if (page.TotalRelation == PublicSearchTotalRelation.Exact)
            {
                Require(page.PrimaryCount + page.RelaxedCount == page.TotalCount, $"[{label}] p{pageNumber} Exact sum mismatch");
                Require(page.TotalCount == oracle.Total,
                    $"[{label}] p{pageNumber} Exact total={page.TotalCount}, expected={oracle.Total} (path={stats.Path})");
            }
            else
            {
                if (checkLowerBoundTierSum)
                    Require(page.PrimaryCount + page.RelaxedCount <= page.TotalCount, $"[{label}] p{pageNumber} LowerBound sum exceeds TotalCount");
                Require(page.TotalCount <= oracle.Total,
                    $"[{label}] p{pageNumber} LowerBound total={page.TotalCount} OVER-REPORTED true total={oracle.Total}!");
            }

            walked.AddRange(page.Hits);
            if (!page.HasMore) break;
            cursor = page.LastHitPosition;
            Require(cursor is not null, $"[{label}] p{pageNumber} HasMore=true without cursor");
            Require(pageNumber <= maxContinuedPages, $"[{label}] p{pageNumber} infinite cursor loop");
        }

        CheckSearchHits(label, oracle.Hits, System.Runtime.InteropServices.CollectionsMarshal.AsSpan(walked), 1e-11);
    }

    internal static void Reject(Action action, string message = "Invalid protocol input accepted") => Reject<ProtocolException>(action, message);

    internal static void Reject<TException>(Action action, string message = "Invalid protocol input accepted") where TException : Exception
    {
        try { action(); }
        catch (TException) { return; }
        throw new InvalidOperationException(message);
    }

    internal static void RejectAll(params Action[] actions)
    {
        foreach (var action in actions) Reject(action);
    }

    internal static void RejectEach<T>(IEnumerable<T> cases, Action<T> action)
    {
        foreach (var item in cases) Reject(() => action(item));
    }

    internal static void RejectTruncations(byte[] frame, Action<ReadOnlySpan<byte>> decode)
    {
        for (int length = 0; length < frame.Length; length++) Reject(() => decode(frame.AsSpan(0, length)));
    }
}
