using System.Buffers;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Helpers.Security;

/// <summary>
/// 现代化 .NET 10 专供 AC 自动机 (支持组合词逻辑 AND 匹配)
/// 终极版: 2026-02-22 (重构构建引擎，消除临时对象风暴，避免运行时GC冻结)
/// </summary>
[SkipLocalsInit]
public class ModernAcAutomaton
{
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct FlatNode
    {
        public int Failure;
        public int ChildrenOffset;
        public int MatchOffset;
        public ushort ChildrenCount;
        public ushort MatchCount;
    }

    private struct FlatRule
    {
        public int Offset;
        public int Count;
    }

    private FlatNode[] _nodes = [];
    private char[] _keys = [];
    private int[] _nexts = [];
    private int[] _first = [];

    private int[] _matchWordIds = [];
    private FlatRule[] _multiWordRules = [];
    private int[] _multiWordRuleComponents = [];
    private bool[] _isSingleWord = [];
    private int _totalWordCount = 0;

    public void Build(string[] keywords)
    {
        if (keywords == null || keywords.Length == 0)
        {
            _nodes = [new FlatNode()];
            _keys = [];
            _nexts = [];
            _first = new int[char.MaxValue + 1];
            _matchWordIds = [];
            _multiWordRules = [];
            _multiWordRuleComponents = [];
            _isSingleWord = [];
            _totalWordCount = 0;
            return;
        }

        var seenLines = new HashSet<string>(StringComparer.Ordinal);
        int wordIdCounter = 0;
        var wordToId = new Dictionary<string, int>(StringComparer.Ordinal);
        var multiRulesTemp = new List<int[]>();
        var singleRulesTemp = new List<int>();

        foreach (var line in keywords)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            if (!seenLines.Add(line)) continue;

            ReadOnlySpan<char> rule = line.AsSpan().Trim();
            if (rule.IsEmpty) continue;

            if (!rule.Contains('+'))
            {
                string w = rule.ToString();
                if (string.IsNullOrEmpty(w)) continue;
                if (!wordToId.TryGetValue(w, out int id))
                {
                    id = wordIdCounter++;
                    wordToId[w] = id;
                }
                singleRulesTemp.Add(id);
            }
            else
            {
                var ruleIds = new List<int>(4);
                int start = 0;
                while (start <= rule.Length)
                {
                    ReadOnlySpan<char> remaining = rule[start..];
                    int separator = remaining.IndexOf('+');
                    ReadOnlySpan<char> part = separator < 0
                        ? remaining.Trim()
                        : remaining[..separator].Trim();

                    if (!part.IsEmpty)
                    {
                        string w = part.ToString();
                        if (!wordToId.TryGetValue(w, out int id))
                        {
                            id = wordIdCounter++;
                            wordToId[w] = id;
                        }
                        ruleIds.Add(id);
                    }

                    if (separator < 0)
                    {
                        break;
                    }

                    start += separator + 1;
                }

                if (ruleIds.Count == 0) continue;
                int[] ruleArr = [.. ruleIds];
                Array.Sort(ruleArr);
                multiRulesTemp.Add(ruleArr);
            }
        }

        _totalWordCount = wordIdCounter;
        _isSingleWord = new bool[_totalWordCount];
        foreach (var id in singleRulesTemp) _isSingleWord[id] = true;

        multiRulesTemp.Sort((a, b) =>
        {
            if (a.Length != b.Length) return a.Length.CompareTo(b.Length);
            return a.AsSpan().SequenceCompareTo(b.AsSpan());
        });

        var rulesList = new List<FlatRule>();
        var compsList = new List<int>();
        int[]? prevRule = null;
        foreach (var r in multiRulesTemp)
        {
            if (prevRule != null && prevRule.AsSpan().SequenceEqual(r.AsSpan())) continue;
            rulesList.Add(new FlatRule { Offset = compsList.Count, Count = r.Length });
            compsList.AddRange(r);
            prevRule = r;
        }
        _multiWordRules = [.. rulesList];
        _multiWordRuleComponents = [.. compsList];

        var root = new BuilderNode();
        foreach (var kvp in wordToId)
        {
            var curr = root;
            foreach (char c in kvp.Key)
            {
                if (!curr.TryGetChild(c, out var next))
                {
                    next = new BuilderNode();
                    curr.AddChild(c, next);
                }
                curr = next!;
            }
            if (!curr.MatchWordIds.Contains(kvp.Value))
            {
                curr.MatchWordIds.Add(kvp.Value);
            }
        }

        var queue = new Queue<BuilderNode>();
        if (root.Children != null)
        {
            foreach (var kvp in root.Children)
            {
                kvp.Value.Failure = root;
                queue.Enqueue(kvp.Value);
            }
        }

        while (queue.Count > 0)
        {
            var curr = queue.Dequeue();
            if (curr.Children == null) continue;

            foreach (var kvp in curr.Children)
            {
                char c = kvp.Key;
                var next = kvp.Value;
                var fail = curr.Failure;
                while (fail != null && !fail.TryGetChild(c, out _))
                {
                    fail = fail.Failure;
                }
                next.Failure = (fail != null && fail.TryGetChild(c, out var failChild)) ? failChild : root;
                if (next.Failure!.MatchWordIds.Count > 0)
                {
                    foreach (var id in next.Failure.MatchWordIds)
                    {
                        if (!next.MatchWordIds.Contains(id)) next.MatchWordIds.Add(id);
                    }
                }
                queue.Enqueue(next);
            }
        }

        var allNodes = new List<BuilderNode>();
        int idCount = 0;
        void AssignIds(BuilderNode node)
        {
            node.Id = idCount++;
            allNodes.Add(node);
            if (node.Children != null)
            {
                foreach (var kvp in node.Children) AssignIds(kvp.Value);
            }
        }
        AssignIds(root);

        _nodes = new FlatNode[allNodes.Count];
        var keysList = new List<char>();
        var nextsList = new List<int>();
        var matchIdsList = new List<int>();

        foreach (var node in allNodes)
        {
            int cOffset = keysList.Count;
            int cCount = node.Children?.Count ?? 0;
            if (cCount > 0)
            {
                // BuilderNode.Children is a SortedDictionary, so each flattened child range stays sorted.
                // FindChildFast depends on this invariant when it switches to binary search for wider nodes.
                foreach (var kvp in node.Children!)
                {
                    keysList.Add(kvp.Key);
                    nextsList.Add(kvp.Value.Id);
                }
            }

            int mOffset = matchIdsList.Count;
            int mCount = node.MatchWordIds.Count;
            if (mCount > 0) matchIdsList.AddRange(node.MatchWordIds);

            _nodes[node.Id] = new FlatNode
            {
                Failure = node.Failure?.Id ?? 0,
                ChildrenOffset = cOffset,
                MatchOffset = mOffset,
                ChildrenCount = (ushort)Math.Min(cCount, ushort.MaxValue),
                MatchCount = (ushort)Math.Min(mCount, ushort.MaxValue)
            };
        }

        _keys = [.. keysList];
        _nexts = [.. nextsList];
        _matchWordIds = [.. matchIdsList];

        _first = new int[char.MaxValue + 1];
        ref FlatNode rootNode = ref _nodes[0];
        int rOffset = rootNode.ChildrenOffset;
        int rCount = rootNode.ChildrenCount;
        for (int i = 0; i < rCount; i++)
        {
            _first[_keys[rOffset + i]] = _nexts[rOffset + i];
        }
    }

    internal bool ValidateSortedChildRangesForTests()
    {
        for (int nodeIndex = 0; nodeIndex < _nodes.Length; nodeIndex++)
        {
            FlatNode node = _nodes[nodeIndex];
            if (node.ChildrenOffset < 0 || node.ChildrenOffset + node.ChildrenCount > _keys.Length)
            {
                return false;
            }

            if (node.ChildrenOffset + node.ChildrenCount > _nexts.Length)
            {
                return false;
            }

            for (int i = 1; i < node.ChildrenCount; i++)
            {
                if (_keys[node.ChildrenOffset + i - 1] >= _keys[node.ChildrenOffset + i])
                {
                    return false;
                }
            }
        }

        return true;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static bool IsValidChar(char c)
    {
        if ((uint)(c - '0') <= 9 || (uint)(c - 'a') <= 25 || (uint)(c - 'A') <= 25) return true;
        if (c >= 0x4E00) return true;
        return false;
    }

    [SkipLocalsInit]
    public bool ContainsAny(ReadOnlySpan<char> text)
    {
        if (_nodes.Length <= 1 || text.IsEmpty) return false;

        int bitMapLength = (_totalWordCount + 31) >> 5;
        uint[]? rentedMap = null;

        Span<uint> hitMap = bitMapLength <= 1024
            ? stackalloc uint[bitMapLength]
            : (rentedMap = ArrayPool<uint>.Shared.Rent(bitMapLength)).AsSpan(0, bitMapLength);

        try
        {
            hitMap.Clear();

            ref char textRef = ref MemoryMarshal.GetReference(text);
            int length = text.Length;

            ref FlatNode nodesRef = ref MemoryMarshal.GetArrayDataReference(_nodes);
            ref char keysRef = ref MemoryMarshal.GetArrayDataReference(_keys);
            ref int nextsRef = ref MemoryMarshal.GetArrayDataReference(_nexts);
            ref int firstRef = ref MemoryMarshal.GetArrayDataReference(_first);
            ref int matchIdsRef = ref MemoryMarshal.GetArrayDataReference(_matchWordIds);
            ref bool isSingleRef = ref MemoryMarshal.GetArrayDataReference(_isSingleWord);
            ref uint hitMapRef = ref MemoryMarshal.GetReference(hitMap);

            int state = 0;
            for (int i = 0; i < length; i++)
            {
                char c = Unsafe.Add(ref textRef, i);
                if (!IsValidChar(c)) continue;

                if (state == 0)
                {
                    state = Unsafe.Add(ref firstRef, c);
                }
                else
                {
                    int next = FindChildFast(state, c, ref nodesRef, ref keysRef, ref nextsRef);
                    while (next == -1 && state != 0)
                    {
                        state = Unsafe.Add(ref nodesRef, state).Failure;
                        next = FindChildFast(state, c, ref nodesRef, ref keysRef, ref nextsRef);
                    }
                    state = next != -1 ? next : Unsafe.Add(ref firstRef, c);
                }

                int matchCount = Unsafe.Add(ref nodesRef, state).MatchCount;
                if (matchCount > 0)
                {
                    int matchOffset = Unsafe.Add(ref nodesRef, state).MatchOffset;
                    for (int m = 0; m < matchCount; m++)
                    {
                        int wid = Unsafe.Add(ref matchIdsRef, matchOffset + m);
                        Unsafe.Add(ref hitMapRef, wid >> 5) |= (1u << (wid & 31));
                        if (Unsafe.Add(ref isSingleRef, wid))
                        {
                            return true;
                        }
                    }
                }
            }

            if (_multiWordRules.Length > 0)
            {
                ref FlatRule rulesRef = ref MemoryMarshal.GetArrayDataReference(_multiWordRules);
                ref int ruleCompsRef = ref MemoryMarshal.GetArrayDataReference(_multiWordRuleComponents);

                for (int i = 0; i < _multiWordRules.Length; i++)
                {
                    ref FlatRule r = ref Unsafe.Add(ref rulesRef, i);
                    bool ruleMatched = true;
                    for (int c = 0; c < r.Count; c++)
                    {
                        int wid = Unsafe.Add(ref ruleCompsRef, r.Offset + c);
                        if ((Unsafe.Add(ref hitMapRef, wid >> 5) & (1u << (wid & 31))) == 0)
                        {
                            ruleMatched = false;
                            break;
                        }
                    }
                    if (ruleMatched) return true;
                }
            }

            return false;
        }
        finally
        {
            if (rentedMap != null)
            {
                ArrayPool<uint>.Shared.Return(rentedMap);
            }
        }
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int FindChildFast(int state, char c, ref FlatNode nodesRef, ref char keysRef, ref int nextsRef)
    {
        ref FlatNode node = ref Unsafe.Add(ref nodesRef, state);
        int count = node.ChildrenCount;
        if (count == 0) return -1;

        int offset = node.ChildrenOffset;

        if (count <= 5)
        {
            ref char startKeys = ref Unsafe.Add(ref keysRef, offset);
            for (int i = 0; i < count; i++)
            {
                if (Unsafe.Add(ref startKeys, i) == c)
                    return Unsafe.Add(ref nextsRef, offset + i);
            }
            return -1;
        }

        int left = offset;
        int right = offset + count - 1;

        while (left <= right)
        {
            int mid = left + ((right - left) >> 1);
            char midChar = Unsafe.Add(ref keysRef, mid);
            if (midChar == c) return Unsafe.Add(ref nextsRef, mid);
            if (midChar < c) left = mid + 1;
            else right = mid - 1;
        }
        return -1;
    }

    private class BuilderNode
    {
        public int Id;
        public SortedDictionary<char, BuilderNode>? Children;
        public BuilderNode? Failure;
        public List<int> MatchWordIds = [];

        public void AddChild(char c, BuilderNode node)
        {
            Children ??= [];
            Children[c] = node;
        }

        public bool TryGetChild(char c, out BuilderNode? node)
        {
            if (Children != null)
            {
                return Children.TryGetValue(c, out node);
            }
            node = null;
            return false;
        }
    }
}
