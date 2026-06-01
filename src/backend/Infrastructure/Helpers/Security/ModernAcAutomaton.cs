using System.Buffers;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Helpers.Security;

/// <summary>
/// 现代化 .NET 10 专供 AC 自动机 (支持组合词逻辑 AND 匹配)
/// 使用 compact alphabet + double-array transitions，避免扫描期 child-range 查找。
/// </summary>
[SkipLocalsInit]
public class ModernAcAutomaton
{
    private const int RootState = 1;
    private const int NoTransition = 0;
    private const string LegacyFeatureSwitchName = "FsusBlog.Security.ModernAcAutomaton.UseLegacyChildRange";
    private const string LegacyFeatureEnvName = "FSUSBLOG_SECURITY_MODERN_AC_USE_LEGACY_CHILD_RANGE";

    private struct FlatRule
    {
        public int Offset;
        public int Count;
    }

    private int[] _base = [];
    private int[] _check = [];
    private int[] _failure = [];
    private int[] _outputLink = [];
    private int[] _matchOffset = [];
    private ushort[] _matchCount = [];
    private int[] _alphabetMap = [];

    private int[] _matchWordIds = [];
    private FlatRule[] _multiWordRules = [];
    private int[] _multiWordRuleComponents = [];
    private int[] _componentRuleOffsets = [];
    private int[] _componentRuleIds = [];
    private bool[] _isSingleWord = [];
    private int _totalWordCount = 0;
    private int _scanEpoch;
    private LegacyModernAcAutomaton? _legacyFallback;

    public void Build(string[] keywords)
    {
        if (UseLegacyChildRangeAutomaton())
        {
            var legacy = new LegacyModernAcAutomaton();
            legacy.Build(keywords);
            _legacyFallback = legacy;
            ResetToEmpty();
            return;
        }

        _legacyFallback = null;
        if (keywords == null || keywords.Length == 0)
        {
            ResetToEmpty();
            return;
        }

        var seenLines = new HashSet<string>(StringComparer.Ordinal);
        int wordIdCounter = 0;
        var wordToId = new Dictionary<string, int>(StringComparer.Ordinal);
        var multiRulesTemp = new List<int[]>();
        var singleRulesTemp = new List<int>();

        foreach (string line in keywords)
        {
            if (string.IsNullOrWhiteSpace(line) || !seenLines.Add(line))
            {
                continue;
            }

            ReadOnlySpan<char> rule = line.AsSpan().Trim();
            if (rule.IsEmpty)
            {
                continue;
            }

            if (!rule.Contains('+'))
            {
                string word = rule.ToString();
                if (string.IsNullOrEmpty(word))
                {
                    continue;
                }

                int id = GetOrAddWordId(word, wordToId, ref wordIdCounter);
                singleRulesTemp.Add(id);
                continue;
            }

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
                    ruleIds.Add(GetOrAddWordId(part.ToString(), wordToId, ref wordIdCounter));
                }

                if (separator < 0)
                {
                    break;
                }

                start += separator + 1;
            }

            if (ruleIds.Count == 0)
            {
                continue;
            }

            int[] ruleArr = [.. ruleIds];
            Array.Sort(ruleArr);
            multiRulesTemp.Add(ruleArr);
        }

        _totalWordCount = wordIdCounter;
        _isSingleWord = new bool[_totalWordCount];
        foreach (int id in singleRulesTemp)
        {
            _isSingleWord[id] = true;
        }

        BuildCompositeRules(multiRulesTemp);
        BuildCompositeRuleIndex();
        BuildDoubleArray(wordToId);
    }

    private static int GetOrAddWordId(string word, Dictionary<string, int> wordToId, ref int wordIdCounter)
    {
        if (wordToId.TryGetValue(word, out int id))
        {
            return id;
        }

        id = wordIdCounter++;
        wordToId[word] = id;
        return id;
    }

    private void BuildCompositeRules(List<int[]> multiRulesTemp)
    {
        if (multiRulesTemp.Count == 0)
        {
            _multiWordRules = [];
            _multiWordRuleComponents = [];
            return;
        }

        multiRulesTemp.Sort(static (a, b) =>
        {
            if (a.Length != b.Length)
            {
                return a.Length.CompareTo(b.Length);
            }

            return a.AsSpan().SequenceCompareTo(b);
        });

        var rulesList = new List<FlatRule>();
        var compsList = new List<int>();
        int[]? prevRule = null;
        foreach (int[] rule in multiRulesTemp)
        {
            if (prevRule != null && prevRule.AsSpan().SequenceEqual(rule))
            {
                continue;
            }

            rulesList.Add(new FlatRule { Offset = compsList.Count, Count = rule.Length });
            compsList.AddRange(rule);
            prevRule = rule;
        }

        _multiWordRules = [.. rulesList];
        _multiWordRuleComponents = [.. compsList];
    }

    private void BuildCompositeRuleIndex()
    {
        if (_totalWordCount == 0 || _multiWordRules.Length == 0)
        {
            _componentRuleOffsets = new int[_totalWordCount + 1];
            _componentRuleIds = [];
            return;
        }

        var counts = new int[_totalWordCount];
        for (int ruleId = 0; ruleId < _multiWordRules.Length; ruleId++)
        {
            FlatRule rule = _multiWordRules[ruleId];
            for (int i = 0; i < rule.Count; i++)
            {
                int wordId = _multiWordRuleComponents[rule.Offset + i];
                counts[wordId]++;
            }
        }

        _componentRuleOffsets = new int[_totalWordCount + 1];
        for (int i = 0; i < counts.Length; i++)
        {
            _componentRuleOffsets[i + 1] = _componentRuleOffsets[i] + counts[i];
        }

        _componentRuleIds = new int[_componentRuleOffsets[^1]];
        var writeOffsets = new int[_totalWordCount];
        _componentRuleOffsets.AsSpan(0, _totalWordCount).CopyTo(writeOffsets);

        for (int ruleId = 0; ruleId < _multiWordRules.Length; ruleId++)
        {
            FlatRule rule = _multiWordRules[ruleId];
            for (int i = 0; i < rule.Count; i++)
            {
                int wordId = _multiWordRuleComponents[rule.Offset + i];
                _componentRuleIds[writeOffsets[wordId]++] = ruleId;
            }
        }
    }

    private void BuildDoubleArray(Dictionary<string, int> wordToId)
    {
        if (wordToId.Count == 0)
        {
            ResetToEmpty();
            return;
        }

        BuilderNode root = BuildTrie(wordToId);
        BuildFailureLinks(root);
        List<BuilderNode> nodes = AssignBuilderIds(root);
        BuildCompactAlphabet(wordToId.Keys);

        var datBase = new List<int> { 0, 0 };
        var datCheck = new List<int> { 0, RootState };
        int[] nodeToState = new int[nodes.Count];
        nodeToState[root.Id] = RootState;

        var queue = new Queue<BuilderNode>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            BuilderNode node = queue.Dequeue();
            int state = nodeToState[node.Id];
            if (node.Children is null || node.Children.Count == 0)
            {
                continue;
            }

            var childIds = new int[node.Children.Count];
            int childIndex = 0;
            foreach (char c in node.Children.Keys)
            {
                childIds[childIndex++] = _alphabetMap[c];
            }

            int baseValue = FindFreeBase(childIds, datCheck);
            EnsureSize(datBase, baseValue + Max(childIds) + 1);
            EnsureSize(datCheck, baseValue + Max(childIds) + 1);
            datBase[state] = baseValue;

            foreach ((char c, BuilderNode child) in node.Children)
            {
                int targetState = baseValue + _alphabetMap[c];
                datCheck[targetState] = state;
                nodeToState[child.Id] = targetState;
                queue.Enqueue(child);
            }
        }

        _base = [.. datBase];
        _check = [.. datCheck];
        _failure = new int[_check.Length];
        _outputLink = new int[_check.Length];
        _matchOffset = new int[_check.Length];
        _matchCount = new ushort[_check.Length];

        var matchIds = new List<int>();
        foreach (BuilderNode node in nodes)
        {
            int state = nodeToState[node.Id];
            _failure[state] = node.Failure is null ? RootState : nodeToState[node.Failure.Id];
            _matchOffset[state] = matchIds.Count;
            _matchCount[state] = (ushort)Math.Min(node.MatchWordIds.Count, ushort.MaxValue);
            if (node.MatchWordIds.Count > 0)
            {
                matchIds.AddRange(node.MatchWordIds);
            }
        }

        var outputQueue = new Queue<BuilderNode>();
        if (root.Children is not null)
        {
            foreach (BuilderNode child in root.Children.Values)
            {
                outputQueue.Enqueue(child);
            }
        }

        while (outputQueue.Count > 0)
        {
            BuilderNode node = outputQueue.Dequeue();
            int state = nodeToState[node.Id];
            int failure = _failure[state];
            _outputLink[state] = _matchCount[failure] > 0 ? failure : _outputLink[failure];
            if (node.Children is null)
            {
                continue;
            }

            foreach (BuilderNode child in node.Children.Values)
            {
                outputQueue.Enqueue(child);
            }
        }

        _matchWordIds = [.. matchIds];
    }

    private static BuilderNode BuildTrie(Dictionary<string, int> wordToId)
    {
        var root = new BuilderNode();
        foreach ((string word, int wordId) in wordToId)
        {
            BuilderNode current = root;
            foreach (char c in word)
            {
                if (!current.TryGetChild(c, out BuilderNode? next))
                {
                    next = new BuilderNode();
                    current.AddChild(c, next);
                }

                current = next!;
            }

            if (!current.MatchWordIds.Contains(wordId))
            {
                current.MatchWordIds.Add(wordId);
            }
        }

        return root;
    }

    private static void BuildFailureLinks(BuilderNode root)
    {
        root.Failure = root;
        var queue = new Queue<BuilderNode>();
        if (root.Children is not null)
        {
            foreach (BuilderNode child in root.Children.Values)
            {
                child.Failure = root;
                queue.Enqueue(child);
            }
        }

        while (queue.Count > 0)
        {
            BuilderNode current = queue.Dequeue();
            if (current.Children is null)
            {
                continue;
            }

            foreach ((char c, BuilderNode next) in current.Children)
            {
                BuilderNode? fail = current.Failure;
                while (fail != root && fail is not null && !fail.TryGetChild(c, out _))
                {
                    fail = fail.Failure;
                }

                next.Failure = fail is not null && fail.TryGetChild(c, out BuilderNode? failChild)
                    ? failChild
                    : root;
                queue.Enqueue(next);
            }
        }
    }

    private static List<BuilderNode> AssignBuilderIds(BuilderNode root)
    {
        var nodes = new List<BuilderNode>();
        var queue = new Queue<BuilderNode>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            BuilderNode node = queue.Dequeue();
            node.Id = nodes.Count;
            nodes.Add(node);
            if (node.Children is null)
            {
                continue;
            }

            foreach (BuilderNode child in node.Children.Values)
            {
                queue.Enqueue(child);
            }
        }

        return nodes;
    }

    private void BuildCompactAlphabet(IEnumerable<string> words)
    {
        var alphabet = new SortedSet<char>();
        foreach (string word in words)
        {
            foreach (char c in word)
            {
                alphabet.Add(c);
            }
        }

        _alphabetMap = new int[char.MaxValue + 1];
        int id = 1;
        foreach (char c in alphabet)
        {
            _alphabetMap[c] = id++;
        }
    }

    private static int FindFreeBase(ReadOnlySpan<int> childIds, List<int> check)
    {
        int maxChildId = Max(childIds);
        for (int candidate = 1; ; candidate++)
        {
            EnsureSize(check, candidate + maxChildId + 1);
            bool available = true;
            foreach (int childId in childIds)
            {
                int index = candidate + childId;
                if (index == RootState || check[index] != 0)
                {
                    available = false;
                    break;
                }
            }

            if (available)
            {
                return candidate;
            }
        }
    }

    private static int Max(ReadOnlySpan<int> values)
    {
        int max = 0;
        foreach (int value in values)
        {
            max = Math.Max(max, value);
        }

        return max;
    }

    private static void EnsureSize(List<int> values, int size)
    {
        while (values.Count < size)
        {
            values.Add(0);
        }
    }

    private void ResetToEmpty()
    {
        _base = [0, 0];
        _check = [0, RootState];
        _failure = [0, RootState];
        _outputLink = [0, 0];
        _matchOffset = [0, 0];
        _matchCount = [0, 0];
        _alphabetMap = new int[char.MaxValue + 1];
        _matchWordIds = [];
        _multiWordRules = [];
        _multiWordRuleComponents = [];
        _componentRuleOffsets = [];
        _componentRuleIds = [];
        _isSingleWord = [];
        _totalWordCount = 0;
    }

    internal bool ValidateSortedChildRangesForTests()
    {
        if (_legacyFallback is { } legacy)
        {
            return legacy.ValidateSortedChildRangesForTests();
        }

        if (_base.Length != _check.Length ||
            _failure.Length != _check.Length ||
            _outputLink.Length != _check.Length ||
            _matchOffset.Length != _check.Length ||
            _matchCount.Length != _check.Length ||
            _check.Length <= RootState ||
            _check[RootState] != RootState)
        {
            return false;
        }

        for (int state = RootState; state < _check.Length; state++)
        {
            if (_check[state] != 0 && (_failure[state] < RootState || _failure[state] >= _check.Length))
            {
                return false;
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
        if (_legacyFallback is { } legacy)
        {
            return legacy.ContainsAny(text);
        }

        if (_check.Length <= RootState || text.IsEmpty) return false;

        int bitMapLength = (_totalWordCount + 31) >> 5;
        uint[]? rentedMap = null;
        int[]? rentedRuleRemaining = null;
        int[]? rentedRuleEpochs = null;

        Span<uint> hitMap = bitMapLength <= 1024
            ? stackalloc uint[bitMapLength]
            : (rentedMap = ArrayPool<uint>.Shared.Rent(bitMapLength)).AsSpan(0, bitMapLength);
        Span<int> ruleRemaining = Span<int>.Empty;
        Span<int> ruleEpochs = Span<int>.Empty;
        int scanEpoch = 0;
        if (_multiWordRules.Length > 0)
        {
            rentedRuleRemaining = ArrayPool<int>.Shared.Rent(_multiWordRules.Length);
            rentedRuleEpochs = ArrayPool<int>.Shared.Rent(_multiWordRules.Length);
            ruleRemaining = rentedRuleRemaining.AsSpan(0, _multiWordRules.Length);
            ruleEpochs = rentedRuleEpochs.AsSpan(0, _multiWordRules.Length);
            scanEpoch = NextScanEpoch();
        }

        try
        {
            hitMap.Clear();

            ref char textRef = ref MemoryMarshal.GetReference(text);
            ref int alphabetRef = ref MemoryMarshal.GetArrayDataReference(_alphabetMap);
            ref int baseRef = ref MemoryMarshal.GetArrayDataReference(_base);
            ref int checkRef = ref MemoryMarshal.GetArrayDataReference(_check);
            ref int failureRef = ref MemoryMarshal.GetArrayDataReference(_failure);
            ref int outputLinkRef = ref MemoryMarshal.GetArrayDataReference(_outputLink);
            ref int matchOffsetRef = ref MemoryMarshal.GetArrayDataReference(_matchOffset);
            ref ushort matchCountRef = ref MemoryMarshal.GetArrayDataReference(_matchCount);
            ref int matchIdsRef = ref MemoryMarshal.GetArrayDataReference(_matchWordIds);
            ref bool isSingleRef = ref MemoryMarshal.GetArrayDataReference(_isSingleWord);
            ref uint hitMapRef = ref MemoryMarshal.GetReference(hitMap);

            int state = RootState;
            for (int i = 0; i < text.Length; i++)
            {
                char c = Unsafe.Add(ref textRef, i);
                if (!IsValidChar(c)) continue;

                int alphabetId = Unsafe.Add(ref alphabetRef, c);
                if (alphabetId == 0)
                {
                    state = RootState;
                    continue;
                }

                state = NextState(state, alphabetId, ref baseRef, ref checkRef, ref failureRef);
                if (ProcessMatches(
                    state,
                    scanEpoch,
                    ruleRemaining,
                    ruleEpochs,
                    ref outputLinkRef,
                    ref matchOffsetRef,
                    ref matchCountRef,
                    ref matchIdsRef,
                    ref isSingleRef,
                    ref hitMapRef))
                {
                    return true;
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

            if (rentedRuleRemaining != null)
            {
                ArrayPool<int>.Shared.Return(rentedRuleRemaining);
            }

            if (rentedRuleEpochs != null)
            {
                ArrayPool<int>.Shared.Return(rentedRuleEpochs);
            }
        }
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private int NextState(
        int state,
        int alphabetId,
        ref int baseRef,
        ref int checkRef,
        ref int failureRef)
    {
        while (true)
        {
            int next = Unsafe.Add(ref baseRef, state) + alphabetId;
            if ((uint)next < (uint)_check.Length && Unsafe.Add(ref checkRef, next) == state)
            {
                return next;
            }

            if (state == RootState)
            {
                return RootState;
            }

            state = Unsafe.Add(ref failureRef, state);
        }
    }

    private bool ProcessMatches(
        int state,
        int scanEpoch,
        Span<int> ruleRemaining,
        Span<int> ruleEpochs,
        ref int outputLinkRef,
        ref int matchOffsetRef,
        ref ushort matchCountRef,
        ref int matchIdsRef,
        ref bool isSingleRef,
        ref uint hitMapRef)
    {
        for (int matchState = state; matchState != NoTransition; matchState = Unsafe.Add(ref outputLinkRef, matchState))
        {
            int matchCount = Unsafe.Add(ref matchCountRef, matchState);
            if (matchCount == 0)
            {
                continue;
            }

            int matchOffset = Unsafe.Add(ref matchOffsetRef, matchState);
            for (int m = 0; m < matchCount; m++)
            {
                int wordId = Unsafe.Add(ref matchIdsRef, matchOffset + m);
                if (Unsafe.Add(ref isSingleRef, wordId))
                {
                    return true;
                }

                ref uint hitBucket = ref Unsafe.Add(ref hitMapRef, wordId >> 5);
                uint hitMask = 1u << (wordId & 31);
                if ((hitBucket & hitMask) != 0)
                {
                    continue;
                }

                hitBucket |= hitMask;
                if (!ruleRemaining.IsEmpty &&
                    TryMarkCompositeComponent(wordId, scanEpoch, ruleRemaining, ruleEpochs))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private int NextScanEpoch()
    {
        int epoch = Interlocked.Increment(ref _scanEpoch);
        return epoch == int.MinValue ? Interlocked.Increment(ref _scanEpoch) : epoch;
    }

    private bool TryMarkCompositeComponent(
        int wordId,
        int scanEpoch,
        Span<int> ruleRemaining,
        Span<int> ruleEpochs)
    {
        int start = _componentRuleOffsets[wordId];
        int end = _componentRuleOffsets[wordId + 1];
        for (int i = start; i < end; i++)
        {
            int ruleId = _componentRuleIds[i];
            if (ruleEpochs[ruleId] != scanEpoch)
            {
                ruleEpochs[ruleId] = scanEpoch;
                ruleRemaining[ruleId] = _multiWordRules[ruleId].Count;
            }

            int remaining = --ruleRemaining[ruleId];
            if (remaining == 0)
            {
                return true;
            }
        }

        return false;
    }

    private static bool UseLegacyChildRangeAutomaton()
    {
        if (AppContext.TryGetSwitch(LegacyFeatureSwitchName, out bool enabled))
        {
            return enabled;
        }

        string? value = Environment.GetEnvironmentVariable(LegacyFeatureEnvName);
        return bool.TryParse(value, out enabled) && enabled;
    }

    private sealed class BuilderNode
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
