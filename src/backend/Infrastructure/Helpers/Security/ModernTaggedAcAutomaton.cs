using System.Buffers;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Helpers.Security;

public readonly record struct ModernTaggedAcRule<TPayload>(
    string Pattern,
    TPayload Payload,
    int Priority);

[SkipLocalsInit]
public sealed class ModernTaggedAcAutomaton<TPayload>
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

    private readonly struct FlatRule(int offset, int count, int payloadIndex, int priority)
    {
        public int Offset { get; } = offset;
        public int Count { get; } = count;
        public int PayloadIndex { get; } = payloadIndex;
        public int Priority { get; } = priority;
    }

    private readonly record struct PendingRule(int[] Components, int PayloadIndex, int Priority);

    private FlatNode[] _nodes = [];
    private char[] _keys = [];
    private int[] _nexts = [];
    private int[] _first = [];

    private int[] _matchWordIds = [];
    private FlatRule[] _multiWordRules = [];
    private int[] _multiWordRuleComponents = [];
    private int[] _componentRuleOffsets = [];
    private int[] _componentRuleIds = [];
    private int[] _singleRulePayloadIndexes = [];
    private TPayload[] _payloads = [];
    private int[] _payloadPriorities = [];
    private int _totalWordCount;
    private int _scanEpoch;

    public void Build(ReadOnlySpan<ModernTaggedAcRule<TPayload>> rules)
    {
        if (rules.IsEmpty)
        {
            ResetToEmpty();
            return;
        }

        var wordToId = new Dictionary<string, int>(StringComparer.Ordinal);
        var singleRules = new Dictionary<int, (int PayloadIndex, int Priority)>();
        var multiRulesTemp = new List<PendingRule>();
        var payloads = new List<TPayload>();
        var payloadPriorities = new List<int>();
        int wordIdCounter = 0;

        for (int i = 0; i < rules.Length; i++)
        {
            ModernTaggedAcRule<TPayload> taggedRule = rules[i];
            ReadOnlySpan<char> rule = taggedRule.Pattern.AsSpan().Trim();
            if (rule.IsEmpty)
            {
                continue;
            }

            int payloadIndex = payloads.Count;
            payloads.Add(taggedRule.Payload);
            payloadPriorities.Add(taggedRule.Priority);

            if (!rule.Contains('+'))
            {
                string word = rule.ToString();
                if (string.IsNullOrEmpty(word))
                {
                    continue;
                }

                int wordId = GetOrAddWordId(word, wordToId, ref wordIdCounter);
                if (!singleRules.TryGetValue(wordId, out var existing) || taggedRule.Priority < existing.Priority)
                {
                    singleRules[wordId] = (payloadIndex, taggedRule.Priority);
                }

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
                    string word = part.ToString();
                    ruleIds.Add(GetOrAddWordId(word, wordToId, ref wordIdCounter));
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

            int[] components = [.. ruleIds];
            Array.Sort(components);
            multiRulesTemp.Add(new PendingRule(components, payloadIndex, taggedRule.Priority));
        }

        _totalWordCount = wordIdCounter;
        _payloads = [.. payloads];
        _payloadPriorities = [.. payloadPriorities];
        _singleRulePayloadIndexes = new int[_totalWordCount];
        Array.Fill(_singleRulePayloadIndexes, -1);
        foreach ((int wordId, (int payloadIndex, _)) in singleRules)
        {
            _singleRulePayloadIndexes[wordId] = payloadIndex;
        }

        BuildCompositeRules(multiRulesTemp);
        BuildCompositeRuleIndex();
        BuildTrie(wordToId);
    }

    [SkipLocalsInit]
    public bool TryFindBest(ReadOnlySpan<char> text, out TPayload payload)
    {
        payload = default!;
        if (_nodes.Length <= 1 || text.IsEmpty || _totalWordCount == 0)
        {
            return false;
        }

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
        int bestPayloadIndex = -1;
        int bestPriority = int.MaxValue;

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
            ref int singlePayloadRef = ref MemoryMarshal.GetArrayDataReference(_singleRulePayloadIndexes);
            ref int payloadPriorityRef = ref MemoryMarshal.GetArrayDataReference(_payloadPriorities);
            ref uint hitMapRef = ref MemoryMarshal.GetReference(hitMap);

            int state = 0;
            for (int i = 0; i < length; i++)
            {
                char c = Unsafe.Add(ref textRef, i);
                if (!IsValidChar(c))
                {
                    continue;
                }

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
                if (matchCount <= 0)
                {
                    continue;
                }

                int matchOffset = Unsafe.Add(ref nodesRef, state).MatchOffset;
                for (int m = 0; m < matchCount; m++)
                {
                    int wordId = Unsafe.Add(ref matchIdsRef, matchOffset + m);

                    int payloadIndex = Unsafe.Add(ref singlePayloadRef, wordId);
                    if (payloadIndex >= 0)
                    {
                        int priority = Unsafe.Add(ref payloadPriorityRef, payloadIndex);
                        if (priority < bestPriority)
                        {
                            bestPriority = priority;
                            bestPayloadIndex = payloadIndex;
                            if (priority == 0)
                            {
                                payload = _payloads[payloadIndex];
                                return true;
                            }
                        }
                    }

                    ref uint hitBucket = ref Unsafe.Add(ref hitMapRef, wordId >> 5);
                    uint hitMask = 1u << (wordId & 31);
                    if ((hitBucket & hitMask) != 0)
                    {
                        continue;
                    }

                    hitBucket |= hitMask;
                    if (_multiWordRules.Length > 0
                        && _componentRuleOffsets[wordId] < _componentRuleOffsets[wordId + 1])
                    {
                        if (ruleRemaining.IsEmpty)
                        {
                            rentedRuleRemaining = ArrayPool<int>.Shared.Rent(_multiWordRules.Length);
                            rentedRuleEpochs = ArrayPool<int>.Shared.Rent(_multiWordRules.Length);
                            ruleRemaining = rentedRuleRemaining.AsSpan(0, _multiWordRules.Length);
                            ruleEpochs = rentedRuleEpochs.AsSpan(0, _multiWordRules.Length);
                            ruleEpochs.Clear();
                            scanEpoch = NextScanEpoch();
                        }

                        if (TryApplyCompositeComponent(
                            wordId,
                            scanEpoch,
                            ruleRemaining,
                            ruleEpochs,
                            ref bestPayloadIndex,
                            ref bestPriority))
                        {
                            payload = _payloads[bestPayloadIndex];
                            return true;
                        }
                    }
                }
            }

            if (bestPayloadIndex < 0)
            {
                return false;
            }

            payload = _payloads[bestPayloadIndex];
            return true;
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

    private int NextScanEpoch()
    {
        int epoch = Interlocked.Increment(ref _scanEpoch);
        return epoch == int.MinValue ? Interlocked.Increment(ref _scanEpoch) : epoch;
    }

    private bool TryApplyCompositeComponent(
        int wordId,
        int scanEpoch,
        Span<int> ruleRemaining,
        Span<int> ruleEpochs,
        ref int bestPayloadIndex,
        ref int bestPriority)
    {
        int start = _componentRuleOffsets[wordId];
        int end = _componentRuleOffsets[wordId + 1];
        for (int i = start; i < end; i++)
        {
            int ruleId = _componentRuleIds[i];
            FlatRule rule = _multiWordRules[ruleId];
            if (rule.Priority >= bestPriority)
            {
                continue;
            }

            if (ruleEpochs[ruleId] != scanEpoch)
            {
                ruleEpochs[ruleId] = scanEpoch;
                ruleRemaining[ruleId] = rule.Count;
            }

            int remaining = --ruleRemaining[ruleId];
            if (remaining == 0)
            {
                bestPriority = rule.Priority;
                bestPayloadIndex = rule.PayloadIndex;
                if (bestPriority == 0)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private void ResetToEmpty()
    {
        _nodes = [new FlatNode()];
        _keys = [];
        _nexts = [];
        _first = new int[char.MaxValue + 1];
        _matchWordIds = [];
        _multiWordRules = [];
        _multiWordRuleComponents = [];
        _componentRuleOffsets = [];
        _componentRuleIds = [];
        _singleRulePayloadIndexes = [];
        _payloads = [];
        _payloadPriorities = [];
        _totalWordCount = 0;
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

    private void BuildCompositeRules(List<PendingRule> pendingRules)
    {
        if (pendingRules.Count == 0)
        {
            _multiWordRules = [];
            _multiWordRuleComponents = [];
            return;
        }

        pendingRules.Sort(static (a, b) =>
        {
            int components = CompareComponents(a.Components, b.Components);
            if (components != 0)
            {
                return components;
            }

            return a.Priority.CompareTo(b.Priority);
        });

        var rulesList = new List<FlatRule>();
        var compsList = new List<int>();
        int[]? previousComponents = null;

        foreach (PendingRule pendingRule in pendingRules)
        {
            if (previousComponents is not null &&
                previousComponents.AsSpan().SequenceEqual(pendingRule.Components))
            {
                continue;
            }

            rulesList.Add(new FlatRule(
                compsList.Count,
                pendingRule.Components.Length,
                pendingRule.PayloadIndex,
                pendingRule.Priority));
            compsList.AddRange(pendingRule.Components);
            previousComponents = pendingRule.Components;
        }

        rulesList.Sort(static (a, b) => a.Priority.CompareTo(b.Priority));
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

    private void BuildTrie(Dictionary<string, int> wordToId)
    {
        var root = new BuilderNode();
        foreach ((string word, int wordId) in wordToId)
        {
            var current = root;
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
            var current = queue.Dequeue();
            if (current.Children == null)
            {
                continue;
            }

            foreach (var kvp in current.Children)
            {
                char c = kvp.Key;
                var next = kvp.Value;
                var fail = current.Failure;
                while (fail != null && !fail.TryGetChild(c, out _))
                {
                    fail = fail.Failure;
                }

                next.Failure = fail != null && fail.TryGetChild(c, out BuilderNode? failChild)
                    ? failChild
                    : root;
                if (next.Failure!.MatchWordIds.Count > 0)
                {
                    foreach (int id in next.Failure.MatchWordIds)
                    {
                        if (!next.MatchWordIds.Contains(id))
                        {
                            next.MatchWordIds.Add(id);
                        }
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
            if (node.Children == null)
            {
                return;
            }

            foreach (var kvp in node.Children)
            {
                AssignIds(kvp.Value);
            }
        }

        AssignIds(root);

        _nodes = new FlatNode[allNodes.Count];
        var keysList = new List<char>();
        var nextsList = new List<int>();
        var matchIdsList = new List<int>();

        foreach (BuilderNode node in allNodes)
        {
            int cOffset = keysList.Count;
            int cCount = node.Children?.Count ?? 0;
            if (cCount > 0)
            {
                foreach (var kvp in node.Children!)
                {
                    keysList.Add(kvp.Key);
                    nextsList.Add(kvp.Value.Id);
                }
            }

            int matchOffset = matchIdsList.Count;
            int matchCount = node.MatchWordIds.Count;
            if (matchCount > 0)
            {
                matchIdsList.AddRange(node.MatchWordIds);
            }

            _nodes[node.Id] = new FlatNode
            {
                Failure = node.Failure?.Id ?? 0,
                ChildrenOffset = cOffset,
                MatchOffset = matchOffset,
                ChildrenCount = (ushort)Math.Min(cCount, ushort.MaxValue),
                MatchCount = (ushort)Math.Min(matchCount, ushort.MaxValue)
            };
        }

        _keys = [.. keysList];
        _nexts = [.. nextsList];
        _matchWordIds = [.. matchIdsList];

        _first = new int[char.MaxValue + 1];
        ref FlatNode rootNode = ref _nodes[0];
        int rootOffset = rootNode.ChildrenOffset;
        int rootCount = rootNode.ChildrenCount;
        for (int i = 0; i < rootCount; i++)
        {
            _first[_keys[rootOffset + i]] = _nexts[rootOffset + i];
        }
    }

    private static int CompareComponents(int[] left, int[] right)
    {
        if (left.Length != right.Length)
        {
            return left.Length.CompareTo(right.Length);
        }

        return left.AsSpan().SequenceCompareTo(right);
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static bool IsValidChar(char c)
    {
        if ((uint)(c - '0') <= 9 || (uint)(c - 'a') <= 25 || (uint)(c - 'A') <= 25)
        {
            return true;
        }

        if (c >= 0x4E00)
        {
            return true;
        }

        return false;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    private static int FindChildFast(int state, char c, ref FlatNode nodesRef, ref char keysRef, ref int nextsRef)
    {
        ref FlatNode node = ref Unsafe.Add(ref nodesRef, state);
        int count = node.ChildrenCount;
        if (count == 0)
        {
            return -1;
        }

        int offset = node.ChildrenOffset;
        if (count <= 5)
        {
            ref char startKeys = ref Unsafe.Add(ref keysRef, offset);
            for (int i = 0; i < count; i++)
            {
                if (Unsafe.Add(ref startKeys, i) == c)
                {
                    return Unsafe.Add(ref nextsRef, offset + i);
                }
            }

            return -1;
        }

        int left = offset;
        int right = offset + count - 1;

        while (left <= right)
        {
            int mid = left + ((right - left) >> 1);
            char midChar = Unsafe.Add(ref keysRef, mid);
            if (midChar == c)
            {
                return Unsafe.Add(ref nextsRef, mid);
            }

            if (midChar < c)
            {
                left = mid + 1;
            }
            else
            {
                right = mid - 1;
            }
        }

        return -1;
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
