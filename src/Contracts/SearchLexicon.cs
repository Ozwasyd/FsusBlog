using System.Text.Json;

namespace FsusBlog.V2.Contracts;

internal static class SearchLexicon
{
    // The four BMP ranges used by the original dictionary. Supplementary scalars
    // still use the existing independent Unicode token path.
    internal static bool IsCjk(char value) => value is >= '\u3400' and <= '\u4dbf' or
        >= '\u4e00' and <= '\u9fff' or >= '\u3040' and <= '\u30ff' or >= '\uac00' and <= '\ud7af';

    private const int MaxSegment = 4096;
    private static readonly Dictionary<string, int> Weights;
    private static readonly HashSet<string> Stopwords;
    private static readonly int MaxWord;

    static SearchLexicon()
    {
        using var resource = typeof(SearchLexicon).Assembly.GetManifestResourceStream("SearchLexicon")!;
        using var data = JsonDocument.Parse(resource);
        Stopwords = data.RootElement.GetProperty("stopwords").EnumerateArray()
            .Select(word => word.GetString()!).ToHashSet(StringComparer.Ordinal);
        Weights = data.RootElement.GetProperty("words").EnumerateObject()
            .Where(word => word.Name.All(IsCjk)).ToDictionary(word => word.Name, word => word.Value.GetInt32(), StringComparer.Ordinal);
        foreach (string word in Stopwords) Weights.TryAdd(word, 1);
        MaxWord = Weights.Keys.Max(word => word.Length);
    }

    internal static bool IsStopword(ReadOnlySpan<char> word) => Stopwords.GetAlternateLookup<ReadOnlySpan<char>>().Contains(word);

    internal static bool IsWord(ReadOnlySpan<char> word) => Weights.GetAlternateLookup<ReadOnlySpan<char>>().ContainsKey(word);

    internal static IEnumerable<(int Start, int Width)> Segment(string text, int start, int end)
    {
        var length = end - start;
        if (length == 1 || length > MaxSegment)
        {
            for (var at = start; at < end; at++) yield return (at, 1);
            yield break;
        }

        var next = new byte[length];
        var scores = new int[length + 1];
        var words = Weights.GetAlternateLookup<ReadOnlySpan<char>>();
        for (var at = length - 1; at >= 0; at--)
        {
            var score = 4 + scores[at + 1];
            var best = 1;
            // Fully integer form of the legacy weight plus 0.25 per scalar.
            // Equal-scoring dictionary paths prefer the longest first term.
            for (var width = Math.Min(MaxWord, length - at); width >= 1; width--)
            {
                if (!words.TryGetValue(text.AsSpan(start + at, width), out var weight)) continue;
                var candidate = 4 * weight + width + scores[at + width];
                if (candidate < score || candidate == score && width <= best) continue;
                (score, best) = (candidate, width);
            }
            next[at] = checked((byte)best);
            scores[at] = score;
        }
        for (var at = 0; at < length; at += next[at]) yield return (start + at, next[at]);
    }
}
