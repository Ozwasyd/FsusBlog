using System.Text;
using BenchmarkDotNet.Attributes;

[MemoryDiagnoser]
public class SearchDictionaryLookupBenchmarks
{
    private readonly SearchDictionaryMatch[] _matches = new SearchDictionaryMatch[32];
    private byte[] _query = [];
    private PrefixBucketLookup _prefixBucket = null!;
    private TrieLookup _trie = null!;

    [Params(128, 1024, 8192)]
    public int DictionarySize { get; set; }

    [GlobalSetup]
    public void Setup()
    {
        SearchDictionaryTerm[] terms = Enumerable.Range(0, DictionarySize)
            .Select(static i => SearchDictionaryTerm.Create(BuildTerm(i), frequency: 1000 - (i % 997)))
            .ToArray();

        _query = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, 128).Select(i => BuildTerm((i * 37) % DictionarySize))));
        _prefixBucket = new PrefixBucketLookup(terms);
        _trie = new TrieLookup(terms);
    }

    [Benchmark(Baseline = true)]
    public int PrefixBucketLinearScan()
        => Scan(_prefixBucket);

    [Benchmark]
    public int TrieWalk()
        => Scan(_trie);

    private int Scan(ISearchDictionaryLookup lookup)
    {
        int totalMatches = 0;
        for (int offset = 0; offset < _query.Length;)
        {
            totalMatches += lookup.CollectMatches(_query.AsSpan(offset), _matches);
            offset += GetUtf8ScalarLength(_query[offset]);
        }

        return totalMatches;
    }

    private static string BuildTerm(int value)
    {
        Span<char> chars = stackalloc char[4];
        chars[0] = '\u4E2D';
        chars[1] = (char)(0x4E00 + (value % 128));
        chars[2] = (char)(0x5200 + ((value / 128) % 128));
        chars[3] = (char)(0x5A00 + ((value / (128 * 128)) % 64));
        return new string(chars);
    }

    private interface ISearchDictionaryLookup
    {
        int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches);
    }

    private sealed class PrefixBucketLookup : ISearchDictionaryLookup
    {
        private readonly Dictionary<byte, SearchDictionaryTerm[]> _entriesByFirstByte;

        public PrefixBucketLookup(SearchDictionaryTerm[] entries)
        {
            _entriesByFirstByte = entries
                .GroupBy(static entry => entry.Bytes[0])
                .ToDictionary(static group => group.Key, static group => group.ToArray());
        }

        public int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches)
        {
            if (source.IsEmpty || !_entriesByFirstByte.TryGetValue(source[0], out SearchDictionaryTerm[]? entries))
            {
                return 0;
            }

            int count = 0;
            foreach (SearchDictionaryTerm entry in entries)
            {
                if (entry.Bytes.Length > source.Length || !source[..entry.Bytes.Length].SequenceEqual(entry.Bytes))
                {
                    continue;
                }

                if (count >= matches.Length)
                {
                    break;
                }

                matches[count++] = new SearchDictionaryMatch(entry.Bytes.Length, entry.RuneLength, entry.Frequency);
            }

            SortMatches(matches, count);
            return count;
        }
    }

    private sealed class TrieLookup : ISearchDictionaryLookup
    {
        private const uint NoTerminal = uint.MaxValue;
        private readonly TrieNode[] _nodes;
        private readonly TrieEdge[] _edges;
        private readonly SearchDictionaryTerm[] _entries;

        public TrieLookup(SearchDictionaryTerm[] entries)
        {
            _entries = entries;
            var nodes = new List<TrieBuildNode> { new() };
            for (int entryIndex = 0; entryIndex < entries.Length; entryIndex++)
            {
                int nodeIndex = 0;
                byte[] bytes = entries[entryIndex].Bytes;
                for (int offset = 0; offset < bytes.Length;)
                {
                    int runeLength = GetUtf8ScalarLength(bytes[offset]);
                    uint scalar = DecodeUtf8Scalar(bytes, offset, runeLength);
                    SortedDictionary<uint, int> children = nodes[nodeIndex].Children;
                    if (!children.TryGetValue(scalar, out int nextNodeIndex))
                    {
                        nextNodeIndex = nodes.Count;
                        children.Add(scalar, nextNodeIndex);
                        nodes.Add(new TrieBuildNode());
                    }

                    nodeIndex = nextNodeIndex;
                    offset += runeLength;
                }

                nodes[nodeIndex].TerminalEntryIndex = (uint)entryIndex;
            }

            _nodes = new TrieNode[nodes.Count];
            var edges = new List<TrieEdge>();
            for (int i = 0; i < nodes.Count; i++)
            {
                TrieBuildNode node = nodes[i];
                uint firstEdgeIndex = (uint)edges.Count;
                foreach ((uint scalar, int targetNodeIndex) in node.Children)
                {
                    edges.Add(new TrieEdge(scalar, (uint)targetNodeIndex));
                }

                _nodes[i] = new TrieNode(firstEdgeIndex, (uint)node.Children.Count, node.TerminalEntryIndex ?? NoTerminal);
            }

            _edges = [.. edges];
        }

        public int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches)
        {
            if (source.IsEmpty)
            {
                return 0;
            }

            int count = 0;
            uint state = 0;
            for (int offset = 0; offset < source.Length;)
            {
                int runeLength = GetUtf8ScalarLength(source[offset]);
                if (runeLength <= 0 || offset + runeLength > source.Length)
                {
                    break;
                }

                uint scalar = DecodeUtf8Scalar(source, offset, runeLength);
                if (!TryFindEdge(state, scalar, out uint nextState))
                {
                    break;
                }

                state = nextState;
                offset += runeLength;

                uint terminal = _nodes[(int)state].TerminalEntryIndex;
                if (terminal == NoTerminal)
                {
                    continue;
                }

                if (count >= matches.Length)
                {
                    break;
                }

                SearchDictionaryTerm entry = _entries[(int)terminal];
                matches[count++] = new SearchDictionaryMatch(entry.Bytes.Length, entry.RuneLength, entry.Frequency);
            }

            SortMatches(matches, count);
            return count;
        }

        private bool TryFindEdge(uint state, uint scalar, out uint nextState)
        {
            TrieNode node = _nodes[(int)state];
            int low = (int)node.FirstEdgeIndex;
            int high = low + (int)node.EdgeCount - 1;
            while (low <= high)
            {
                int mid = low + ((high - low) / 2);
                TrieEdge edge = _edges[mid];
                if (edge.Scalar == scalar)
                {
                    nextState = edge.TargetNodeIndex;
                    return true;
                }

                if (edge.Scalar < scalar)
                {
                    low = mid + 1;
                }
                else
                {
                    high = mid - 1;
                }
            }

            nextState = 0;
            return false;
        }

        private sealed class TrieBuildNode
        {
            public SortedDictionary<uint, int> Children { get; } = [];
            public uint? TerminalEntryIndex { get; set; }
        }

        private readonly record struct TrieNode(uint FirstEdgeIndex, uint EdgeCount, uint TerminalEntryIndex);
        private readonly record struct TrieEdge(uint Scalar, uint TargetNodeIndex);
    }

    private static void SortMatches(Span<SearchDictionaryMatch> matches, int count)
    {
        if (count > 1)
        {
            matches[..count].Sort(static (left, right) =>
            {
                int byRunes = right.RuneLength.CompareTo(left.RuneLength);
                return byRunes != 0 ? byRunes : right.Frequency.CompareTo(left.Frequency);
            });
        }
    }

    private static int GetUtf8ScalarLength(byte value)
        => value switch
        {
            < 0x80 => 1,
            >= 0xC2 and < 0xE0 => 2,
            >= 0xE0 and < 0xF0 => 3,
            >= 0xF0 and < 0xF8 => 4,
            _ => 1
        };

    private static uint DecodeUtf8Scalar(ReadOnlySpan<byte> source, int offset, int runeLength)
        => runeLength switch
        {
            1 => source[offset],
            2 => (uint)((source[offset] & 0x1F) << 6 | (source[offset + 1] & 0x3F)),
            3 => (uint)((source[offset] & 0x0F) << 12 | (source[offset + 1] & 0x3F) << 6 | (source[offset + 2] & 0x3F)),
            4 => (uint)((source[offset] & 0x07) << 18 | (source[offset + 1] & 0x3F) << 12 | (source[offset + 2] & 0x3F) << 6 | (source[offset + 3] & 0x3F)),
            _ => 0
        };

    private readonly record struct SearchDictionaryTerm(byte[] Bytes, int RuneLength, int Frequency)
    {
        public static SearchDictionaryTerm Create(string text, int frequency)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text);
            return new SearchDictionaryTerm(bytes, text.Length, frequency);
        }
    }

    private readonly record struct SearchDictionaryMatch(int ByteLength, int RuneLength, int Frequency);
}
