using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32.SafeHandles;

using SqlSugar;

namespace FsusBlog.Server.Services;

public sealed partial class SearchIndexService
{
    private interface ISearchDictionaryLookup
    {
        int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches);
        bool TryFindExactMatch(ReadOnlySpan<byte> source, out SearchDictionaryMatch match);
        string ResolveUtf8(uint hash);
    }

    private ref struct SearchTokenizer
    {
        private readonly ISearchDictionaryLookup _dictionary;
        private readonly SearchFieldKind _field;
        private ReadOnlySpan<byte> _source;
        private int _index;
        private uint _position;
        private SearchToken[] _queuedTokens;
        private bool _queuedTokensRented;
        private int _queuedIndex;
        private int _queuedCount;

        public SearchTokenizer(ISearchDictionaryLookup dictionary, SearchFieldKind field, ReadOnlySpan<byte> source)
        {
            _dictionary = dictionary;
            _field = field;
            _source = source;
            _index = 0;
            _position = 0;
            _queuedTokens = [];
            _queuedTokensRented = false;
            _queuedIndex = 0;
            _queuedCount = 0;
        }

        public string GetDebugText(SearchToken token)
            => _dictionary.ResolveUtf8(token.Hash);

        public bool MoveNext(out SearchToken token)
        {
            if (_queuedIndex < _queuedCount)
            {
                token = _queuedTokens[_queuedIndex++];
                if (_queuedIndex == _queuedCount)
                {
                    ReturnQueuedTokenBuffer();
                }

                return true;
            }

            while (_index < _source.Length)
            {
                byte current = _source[_index];
                if (IsAsciiWord(current))
                {
                    return MoveAscii(out token);
                }

                int runeLength = GetUtf8ScalarLength(current);
                if (runeLength <= 0 || _index + runeLength > _source.Length)
                {
                    _index++;
                    continue;
                }

                uint scalar = DecodeUtf8Scalar(_source, _index, runeLength);
                if (IsIgnorableScalar(scalar))
                {
                    _index += runeLength;
                    continue;
                }

                if (IsCjkScalar(scalar) && QueueCjkSegmentTokens())
                {
                    token = _queuedTokens[_queuedIndex++];
                    if (_queuedIndex == _queuedCount)
                    {
                        ReturnQueuedTokenBuffer();
                    }

                    return true;
                }

                ReadOnlySpan<byte> unigramBytes = _source.Slice(_index, runeLength);
                uint unigramHash = MurmurHash3.HashBytes(unigramBytes);
                token = new SearchToken(unigramHash, unigramHash, _field, _position, 1, false, _field is SearchFieldKind.Title or SearchFieldKind.Body);
                _index += runeLength;
                _position++;
                return true;
            }

            token = default;
            return false;
        }

        private bool QueueCjkSegmentTokens()
        {
            ReturnQueuedTokenBuffer();
            int segmentStart = _index;
            int cursor = _index;
            int runeCount = 0;
            while (cursor < _source.Length)
            {
                int runeLength = GetUtf8ScalarLength(_source[cursor]);
                if (runeLength <= 0 || cursor + runeLength > _source.Length)
                {
                    break;
                }

                uint scalar = DecodeUtf8Scalar(_source, cursor, runeLength);
                if (!IsCjkScalar(scalar))
                {
                    break;
                }

                cursor += runeLength;
                runeCount++;
            }

            if (runeCount == 0 || cursor <= segmentStart)
            {
                return false;
            }

            if (runeCount > MaxCjkSegmentRunes)
            {
                return false;
            }

            ReadOnlySpan<byte> segment = _source[segmentStart..cursor];
            const int StackRuneThreshold = 96;
            int[]? rentedOffsets = null;
            double[]? rentedScores = null;
            int[]? rentedLengths = null;
            bool[]? rentedStopwords = null;
            SearchToken[]? queued = null;
            bool queuedRented = false;

            Span<int> runeOffsets = (rentedOffsets = ArrayPool<int>.Shared.Rent(runeCount + 1)).AsSpan(0, runeCount + 1);
            Span<double> bestScores = runeCount <= StackRuneThreshold
                ? stackalloc double[runeCount + 1]
                : (rentedScores = ArrayPool<double>.Shared.Rent(runeCount + 1)).AsSpan(0, runeCount + 1);
            Span<int> bestLengths = runeCount <= StackRuneThreshold
                ? stackalloc int[runeCount]
                : (rentedLengths = ArrayPool<int>.Shared.Rent(runeCount)).AsSpan(0, runeCount);
            Span<bool> bestStopwords = runeCount <= StackRuneThreshold
                ? stackalloc bool[runeCount]
                : (rentedStopwords = ArrayPool<bool>.Shared.Rent(runeCount)).AsSpan(0, runeCount);

            try
            {
                int localOffset = 0;
                for (int i = 0; i < runeCount; i++)
                {
                    runeOffsets[i] = localOffset;
                    localOffset += GetUtf8ScalarLength(segment[localOffset]);
                }
                runeOffsets[runeCount] = segment.Length;

                Span<SearchDictionaryMatch> matches = stackalloc SearchDictionaryMatch[32];

                for (int runeIndex = runeCount - 1; runeIndex >= 0; runeIndex--)
                {
                    ReadOnlySpan<byte> suffix = segment[runeOffsets[runeIndex]..];
                    int matchCount = _dictionary.CollectMatches(suffix, matches);

                    double bestScore = double.NegativeInfinity;
                    int bestLength = 1;
                    bool bestStopword = false;

                    if (matchCount > 0)
                    {
                        for (int i = 0; i < matchCount; i++)
                        {
                            SearchDictionaryMatch match = matches[i];
                            if (match.RuneLength <= 0 || runeIndex + match.RuneLength > runeCount)
                            {
                                continue;
                            }

                            double score = match.Frequency + (match.RuneLength * 0.25d) + bestScores[runeIndex + match.RuneLength];
                            if (score > bestScore)
                            {
                                bestScore = score;
                                bestLength = match.RuneLength;
                                bestStopword = match.Stopword;
                            }
                        }
                    }

                    double unigramScore = 1d + bestScores[runeIndex + 1];
                    if (bestScore < unigramScore)
                    {
                        bestScore = unigramScore;
                        bestLength = 1;
                        bestStopword = false;
                    }

                    bestScores[runeIndex] = bestScore;
                    bestLengths[runeIndex] = bestLength;
                    bestStopwords[runeIndex] = bestStopword;
                }

                int queuedCapacity = Math.Max(1, runeCount * 2);
                queued = ArrayPool<SearchToken>.Shared.Rent(queuedCapacity);
                queuedRented = true;
                int queuedCount = 0;
                uint basePosition = _position;
                for (int runeIndex = 0; runeIndex < runeCount;)
                {
                    int runeLength = Math.Max(1, bestLengths[runeIndex]);
                    int tokenByteStart = runeOffsets[runeIndex];
                    int tokenByteLength = runeOffsets[runeIndex + runeLength] - tokenByteStart;
                    ReadOnlySpan<byte> tokenBytes = segment.Slice(tokenByteStart, tokenByteLength);
                    uint tokenPosition = basePosition + (uint)runeIndex;
                    bool keepPositions = _field is SearchFieldKind.Title or SearchFieldKind.Body;

                    EnsureQueuedCapacity(ref queued, ref queuedRented, queuedCount + 1);
                    uint tokenHash = MurmurHash3.HashBytes(tokenBytes);
                    queued[queuedCount++] = new SearchToken(
                        tokenHash,
                        tokenHash,
                        _field,
                        tokenPosition,
                        (uint)runeLength,
                        bestStopwords[runeIndex],
                        keepPositions);

                    if (runeLength >= 3)
                    {
                        int maxSubtokens = (runeLength * (runeLength - 1)) / 2;
                        EnsureQueuedCapacity(ref queued, ref queuedRented, queuedCount + maxSubtokens);
                        QueueDictionarySubtokens(segment, runeOffsets, runeIndex, runeLength, basePosition, keepPositions, queued, ref queuedCount);
                    }

                    runeIndex += runeLength;
                }

                if (queuedCount == 0)
                {
                    ArrayPool<SearchToken>.Shared.Return(queued, clearArray: false);
                    return false;
                }

                _queuedTokens = queued;
                _queuedTokensRented = queuedRented;
                queued = null;
                queuedRented = false;
                _queuedIndex = 0;
                _queuedCount = queuedCount;
                _index = cursor;
                _position += (uint)runeCount;
                return true;
            }
            finally
            {
                if (queued is not null && queuedRented)
                {
                    ArrayPool<SearchToken>.Shared.Return(queued, clearArray: false);
                }

                if (rentedOffsets is not null)
                {
                    ArrayPool<int>.Shared.Return(rentedOffsets, clearArray: false);
                }

                if (rentedScores is not null)
                {
                    ArrayPool<double>.Shared.Return(rentedScores, clearArray: false);
                }

                if (rentedLengths is not null)
                {
                    ArrayPool<int>.Shared.Return(rentedLengths, clearArray: false);
                }

                if (rentedStopwords is not null)
                {
                    ArrayPool<bool>.Shared.Return(rentedStopwords, clearArray: true);
                }
            }
        }

        private bool MoveAscii(out SearchToken token)
        {
            int start = _index;
            while (_index < _source.Length && IsAsciiWord(_source[_index]))
            {
                _index++;
            }

            int length = _index - start;
            Span<byte> lower = length <= 128 ? stackalloc byte[length] : new byte[length];
            _source.Slice(start, length).CopyTo(lower);
            for (int i = 0; i < lower.Length; i++)
            {
                byte value = lower[i];
                if (value is >= (byte)'A' and <= (byte)'Z')
                {
                    lower[i] = (byte)(value + 32);
                }
            }

            uint tokenHash = MurmurHash3.HashBytes(lower);
            token = new SearchToken(tokenHash, tokenHash, _field, _position, 1, false, _field is SearchFieldKind.Title or SearchFieldKind.Body);
            _position++;
            return true;
        }

        private void QueueDictionarySubtokens(
            ReadOnlySpan<byte> segment,
            ReadOnlySpan<int> runeOffsets,
            int tokenRuneIndex,
            int tokenRuneLength,
            uint basePosition,
            bool keepPositions,
            SearchToken[] queued,
            ref int queuedCount)
        {
            for (int subStart = tokenRuneIndex; subStart < tokenRuneIndex + tokenRuneLength; subStart++)
            {
                int maxSubLength = tokenRuneLength - (subStart - tokenRuneIndex);
                for (int subLength = 2; subLength <= Math.Min(maxSubLength, tokenRuneLength - 1); subLength++)
                {
                    int subByteStart = runeOffsets[subStart];
                    int subByteLength = runeOffsets[subStart + subLength] - subByteStart;
                    ReadOnlySpan<byte> subBytes = segment.Slice(subByteStart, subByteLength);
                    if (!_dictionary.TryFindExactMatch(subBytes, out SearchDictionaryMatch match))
                    {
                        continue;
                    }

                    uint subHash = MurmurHash3.HashBytes(subBytes);
                    SearchToken subToken = new(
                        subHash,
                        subHash,
                        _field,
                        basePosition + (uint)subStart,
                        (uint)subLength,
                        match.Stopword,
                        keepPositions);

                    bool duplicate = false;
                    for (int i = 0; i < queuedCount; i++)
                    {
                        if (queued[i].Hash == subToken.Hash
                            && queued[i].Position == subToken.Position
                            && queued[i].PositionLength == subToken.PositionLength)
                        {
                            duplicate = true;
                            break;
                        }
                    }

                    if (!duplicate)
                    {
                        if (queuedCount >= queued.Length)
                        {
                            return;
                        }

                        queued[queuedCount++] = subToken;
                    }
                }
            }
        }

        private void ReturnQueuedTokenBuffer()
        {
            if (_queuedTokensRented && _queuedTokens.Length > 0)
            {
                ArrayPool<SearchToken>.Shared.Return(_queuedTokens, clearArray: false);
            }

            _queuedTokens = [];
            _queuedTokensRented = false;
            _queuedIndex = 0;
            _queuedCount = 0;
        }

        private static void EnsureQueuedCapacity(ref SearchToken[] queued, ref bool queuedRented, int required)
        {
            if (queued.Length >= required)
            {
                return;
            }

            int newCapacity = Math.Max(required, queued.Length + 8);
            SearchToken[] replacement = ArrayPool<SearchToken>.Shared.Rent(newCapacity);
            queued.AsSpan(0, Math.Min(queued.Length, required - 1)).CopyTo(replacement);
            if (queuedRented)
            {
                ArrayPool<SearchToken>.Shared.Return(queued, clearArray: false);
            }

            queued = replacement;
            queuedRented = true;
        }

        private static bool IsAsciiWord(byte value)
            => value is >= (byte)'a' and <= (byte)'z'
                || value is >= (byte)'A' and <= (byte)'Z'
                || value is >= (byte)'0' and <= (byte)'9';

        internal static int GetUtf8ScalarLength(byte value)
            => value switch
            {
                < 0x80 => 1,
                >= 0xC2 and < 0xE0 => 2,
                >= 0xE0 and < 0xF0 => 3,
                >= 0xF0 and < 0xF8 => 4,
                _ => 1
            };

        internal static uint DecodeUtf8Scalar(ReadOnlySpan<byte> source, int offset, int runeLength)
            => runeLength switch
            {
                1 => source[offset],
                2 => (uint)((source[offset] & 0x1F) << 6 | (source[offset + 1] & 0x3F)),
                3 => (uint)((source[offset] & 0x0F) << 12 | (source[offset + 1] & 0x3F) << 6 | (source[offset + 2] & 0x3F)),
                4 => (uint)((source[offset] & 0x07) << 18 | (source[offset + 1] & 0x3F) << 12 | (source[offset + 2] & 0x3F) << 6 | (source[offset + 3] & 0x3F)),
                _ => 0
            };

        private static bool IsCjkScalar(uint scalar)
            => scalar is >= 0x4E00 and <= 0x9FFF
                || scalar is >= 0x3400 and <= 0x4DBF
                || scalar is >= 0x3040 and <= 0x30FF
                || scalar is >= 0xAC00 and <= 0xD7AF;

        private static bool IsIgnorableScalar(uint scalar)
            => scalar <= 0x20
                || char.IsPunctuation((char)scalar)
                || char.IsWhiteSpace((char)scalar);
    }

    private static class SearchDictionaryCompiler
    {
        internal const uint Magic = 0x4C445346; // FSDL
        internal const uint Version = 2;

        public static void CompileIfNeeded(string sourceRoot, string outputPath, ILogger logger)
        {
            string corePath = Path.Combine(sourceRoot, "core.dict.txt");
            string domainPath = Path.Combine(sourceRoot, "domain.dict.txt");
            string stopwordsPath = Path.Combine(sourceRoot, "stopwords.txt");

            DateTime latestSource = new[] { corePath, domainPath, stopwordsPath }
                .Where(File.Exists)
                .Select(File.GetLastWriteTimeUtc)
                .DefaultIfEmpty(DateTime.MinValue)
                .Max();

            if (IsCompiledDictionaryCurrent(outputPath, latestSource))
            {
                return;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
            Dictionary<string, LexiconEntryBuilder> entries = [];
            LoadEntries(corePath, entries, stopword: false);
            LoadEntries(domainPath, entries, stopword: false);
            LoadEntries(stopwordsPath, entries, stopword: true);

            LexiconEntryBuilder[] ordered = entries.Values
                .OrderBy(it => it.Bytes.Length == 0 ? 0 : it.Bytes[0])
                .ThenBy(it => Convert.ToHexStringLower(it.Bytes), StringComparer.Ordinal)
                .ToArray();
            SearchDictionaryTrieBuild trie = BuildTrie(ordered);

            using var strings = new PooledByteBufferWriter(Math.Max(ordered.Sum(it => it.Bytes.Length), 256));
            using var writer = new PooledByteBufferWriter(4096);
            WriteUInt32(writer, Magic);
            WriteUInt32(writer, Version);
            WriteUInt32(writer, (uint)trie.Nodes.Length);
            WriteUInt32(writer, (uint)trie.Edges.Length);
            WriteUInt32(writer, (uint)ordered.Length);

            foreach (SearchDictionaryNode node in trie.Nodes)
            {
                WriteUInt32(writer, node.FirstEdgeIndex);
                WriteUInt32(writer, node.EdgeCount);
                WriteUInt32(writer, node.TerminalEntryIndex);
                WriteUInt32(writer, 0);
            }

            foreach (SearchDictionaryEdge edge in trie.Edges)
            {
                WriteUInt32(writer, edge.Scalar);
                WriteUInt32(writer, edge.TargetNodeIndex);
            }

            var offsets = new uint[ordered.Length];
            for (int i = 0; i < ordered.Length; i++)
            {
                offsets[i] = (uint)strings.WrittenCount;
                strings.Write(ordered[i].Bytes);
            }

            for (int i = 0; i < ordered.Length; i++)
            {
                LexiconEntryBuilder entry = ordered[i];
                WriteUInt32(writer, offsets[i]);
                WriteUInt16(writer, checked((ushort)entry.Bytes.Length));
                WriteUInt16(writer, entry.Stopword ? (ushort)1 : (ushort)0);
                WriteUInt32(writer, (uint)entry.Frequency);
                WriteUInt32(writer, (uint)entry.RuneLength);
            }

            byte[] stringBytes = strings.ToArray();
            WriteUInt32(writer, (uint)stringBytes.Length);
            writer.Write(stringBytes);
            File.WriteAllBytes(outputPath, writer.ToArray());
            logger.LogInformation(
                "search lexicon compiled to {Path} with {Count} entries, {NodeCount} trie nodes and {EdgeCount} trie edges",
                outputPath,
                ordered.Length,
                trie.Nodes.Length,
                trie.Edges.Length);
        }

        private static bool IsCompiledDictionaryCurrent(string outputPath, DateTime latestSource)
        {
            if (!File.Exists(outputPath) || File.GetLastWriteTimeUtc(outputPath) < latestSource)
            {
                return false;
            }

            Span<byte> header = stackalloc byte[8];
            try
            {
                using FileStream stream = File.OpenRead(outputPath);
                if (stream.Read(header) != header.Length)
                {
                    return false;
                }
            }
            catch (IOException)
            {
                return false;
            }
            catch (UnauthorizedAccessException)
            {
                return false;
            }

            return BinaryPrimitives.ReadUInt32LittleEndian(header[..4]) == Magic
                && BinaryPrimitives.ReadUInt32LittleEndian(header[4..]) == Version;
        }

        private static SearchDictionaryTrieBuild BuildTrie(LexiconEntryBuilder[] entries)
        {
            var nodes = new List<TrieBuildNode> { new() };
            for (uint entryIndex = 0; entryIndex < entries.Length; entryIndex++)
            {
                LexiconEntryBuilder entry = entries[checked((int)entryIndex)];
                int nodeIndex = 0;
                foreach (uint scalar in DecodeScalars(entry.Bytes))
                {
                    SortedDictionary<uint, int> children = nodes[nodeIndex].Children;
                    if (!children.TryGetValue(scalar, out int nextNodeIndex))
                    {
                        nextNodeIndex = nodes.Count;
                        children.Add(scalar, nextNodeIndex);
                        nodes.Add(new TrieBuildNode());
                    }

                    nodeIndex = nextNodeIndex;
                }

                nodes[nodeIndex].TerminalEntryIndex = entryIndex;
            }

            var nodeRecords = new SearchDictionaryNode[nodes.Count];
            var edges = new List<SearchDictionaryEdge>();
            for (int nodeIndex = 0; nodeIndex < nodes.Count; nodeIndex++)
            {
                TrieBuildNode node = nodes[nodeIndex];
                uint firstEdgeIndex = (uint)edges.Count;
                foreach ((uint scalar, int targetNodeIndex) in node.Children)
                {
                    edges.Add(new SearchDictionaryEdge(scalar, (uint)targetNodeIndex));
                }

                nodeRecords[nodeIndex] = new SearchDictionaryNode(
                    firstEdgeIndex,
                    (uint)node.Children.Count,
                    node.TerminalEntryIndex ?? NoSearchDictionaryTerminal);
            }

            return new SearchDictionaryTrieBuild(nodeRecords, [.. edges]);
        }

        private static uint[] DecodeScalars(byte[] bytes)
        {
            var scalars = new List<uint>(Math.Max(1, bytes.Length / 3));
            for (int offset = 0; offset < bytes.Length;)
            {
                int runeLength = SearchTokenizer.GetUtf8ScalarLength(bytes[offset]);
                if (runeLength <= 0 || offset + runeLength > bytes.Length)
                {
                    break;
                }

                scalars.Add(SearchTokenizer.DecodeUtf8Scalar(bytes, offset, runeLength));
                offset += runeLength;
            }

            return [.. scalars];
        }

        private static int CountScalars(byte[] bytes)
        {
            int count = 0;
            for (int offset = 0; offset < bytes.Length;)
            {
                int runeLength = SearchTokenizer.GetUtf8ScalarLength(bytes[offset]);
                if (runeLength <= 0 || offset + runeLength > bytes.Length)
                {
                    break;
                }

                offset += runeLength;
                count++;
            }

            return count;
        }

        private static void LoadEntries(string path, Dictionary<string, LexiconEntryBuilder> target, bool stopword)
        {
            if (!File.Exists(path))
            {
                return;
            }

            foreach (string raw in File.ReadLines(path, Encoding.UTF8))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#", StringComparison.Ordinal))
                {
                    continue;
                }

                string[] parts = line.Split('\t', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                string term = parts[0];
                int frequency = stopword
                    ? 1
                    : parts.Length >= 2 && int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
                        ? parsed
                        : 1;

                if (target.TryGetValue(term, out LexiconEntryBuilder? existing))
                {
                    existing.Frequency = Math.Max(existing.Frequency, frequency);
                    existing.Stopword |= stopword;
                    continue;
                }

                byte[] bytes = Encoding.UTF8.GetBytes(term);
                target[term] = new LexiconEntryBuilder
                {
                    Bytes = bytes,
                    RuneLength = CountScalars(bytes),
                    Frequency = frequency,
                    Stopword = stopword
                };
            }
        }

        private sealed class LexiconEntryBuilder
        {
            public byte[] Bytes { get; init; } = [];
            public int RuneLength
            {
                get; init;
            }
            public int Frequency
            {
                get; set;
            }
            public bool Stopword
            {
                get; set;
            }
        }

        private sealed class TrieBuildNode
        {
            public SortedDictionary<uint, int> Children { get; } = [];
            public uint? TerminalEntryIndex
            {
                get; set;
            }
        }
    }

    private sealed unsafe class SearchDictionaryRuntime : ISearchDictionaryLookup, IDisposable
    {
        private readonly MemoryMappedFile _mmf;
        private readonly MemoryMappedViewAccessor _view;
        private readonly SafeMemoryMappedViewHandle _handle;
        private byte* _basePtr;
        private readonly SearchDictionaryNode[] _nodes;
        private readonly SearchDictionaryEdge[] _edges;
        private readonly SearchDictionaryEntry[] _entries;
        private readonly int _stringsBaseOffset;

        private SearchDictionaryRuntime(
            MemoryMappedFile mmf,
            MemoryMappedViewAccessor view,
            SafeMemoryMappedViewHandle handle,
            byte* basePtr,
            SearchDictionaryNode[] nodes,
            SearchDictionaryEdge[] edges,
            SearchDictionaryEntry[] entries,
            int stringsBaseOffset)
        {
            _mmf = mmf;
            _view = view;
            _handle = handle;
            _basePtr = basePtr;
            _nodes = nodes;
            _edges = edges;
            _entries = entries;
            _stringsBaseOffset = stringsBaseOffset;
        }

        public static SearchDictionaryRuntime Open(string path)
        {
            MemoryMappedFile? mmf = null;
            MemoryMappedViewAccessor? view = null;
            SafeMemoryMappedViewHandle? handle = null;
            byte* basePtr = null;
            bool pointerAcquired = false;

            try
            {
                mmf = MemoryMappedFile.CreateFromFile(path, FileMode.Open, null, 0, MemoryMappedFileAccess.Read);
                view = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
                handle = view.SafeMemoryMappedViewHandle;
                handle.AcquirePointer(ref basePtr);
                pointerAcquired = true;
                if (basePtr is null)
                {
                    throw new InvalidOperationException("Failed to acquire search dictionary pointer.");
                }

                byte* cursor = basePtr;
                uint magic = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                uint version = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                if (magic != SearchDictionaryCompiler.Magic || version != SearchDictionaryCompiler.Version)
                {
                    throw new InvalidDataException("search dictionary header invalid");
                }

                uint nodeCount = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                uint edgeCount = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                uint entryCount = Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);

                var nodes = new SearchDictionaryNode[checked((int)nodeCount)];
                for (int i = 0; i < nodes.Length; i++)
                {
                    nodes[i] = new SearchDictionaryNode(
                        Unsafe.ReadUnaligned<uint>(cursor),
                        Unsafe.ReadUnaligned<uint>(cursor + 4),
                        Unsafe.ReadUnaligned<uint>(cursor + 8));
                    cursor += 16;
                }

                var edges = new SearchDictionaryEdge[checked((int)edgeCount)];
                for (int i = 0; i < edges.Length; i++)
                {
                    edges[i] = new SearchDictionaryEdge(
                        Unsafe.ReadUnaligned<uint>(cursor),
                        Unsafe.ReadUnaligned<uint>(cursor + 4));
                    cursor += 8;
                }

                var entries = new SearchDictionaryEntry[checked((int)entryCount)];
                for (int i = 0; i < entryCount; i++)
                {
                    uint offset = Unsafe.ReadUnaligned<uint>(cursor);
                    ushort length = Unsafe.ReadUnaligned<ushort>(cursor + 4);
                    ushort flags = Unsafe.ReadUnaligned<ushort>(cursor + 6);
                    uint frequency = Unsafe.ReadUnaligned<uint>(cursor + 8);
                    uint runeLength = Unsafe.ReadUnaligned<uint>(cursor + 12);
                    entries[i] = new SearchDictionaryEntry(offset, length, frequency, runeLength, (flags & 1) != 0);
                    cursor += 16;
                }

                _ = (int)Unsafe.ReadUnaligned<uint>(cursor);
                cursor += sizeof(uint);
                int stringsBaseOffset = (int)(cursor - basePtr);
                return new SearchDictionaryRuntime(mmf, view, handle, basePtr, nodes, edges, entries, stringsBaseOffset);
            }
            catch
            {
                if (pointerAcquired && handle is not null)
                {
                    handle.ReleasePointer();
                }

                view?.Dispose();
                mmf?.Dispose();
                throw;
            }
        }

        public ISearchDictionaryLookup CreateSnapshot()
        {
            var nodes = (SearchDictionaryNode[])_nodes.Clone();
            var edges = (SearchDictionaryEdge[])_edges.Clone();
            var entries = new SearchDictionaryEntry[_entries.Length];
            int stringBytesLength = 0;
            foreach (SearchDictionaryEntry entry in _entries)
            {
                stringBytesLength += entry.ByteLength;
            }

            var strings = new byte[stringBytesLength];
            int stringOffset = 0;
            for (int i = 0; i < _entries.Length; i++)
            {
                SearchDictionaryEntry entry = _entries[i];
                ReadOnlySpan<byte> candidate = new(_basePtr + _stringsBaseOffset + entry.StringOffset, entry.ByteLength);
                candidate.CopyTo(strings.AsSpan(stringOffset, entry.ByteLength));
                entries[i] = entry with
                {
                    StringOffset = (uint)stringOffset
                };
                stringOffset += entry.ByteLength;
            }

            return new SearchDictionarySnapshot(nodes, edges, entries, strings);
        }

        public int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches)
            => CollectTrieMatches(source, matches, _nodes, _edges, _entries);

        public bool TryFindExactMatch(ReadOnlySpan<byte> source, out SearchDictionaryMatch match)
        {
            Span<SearchDictionaryMatch> matches = stackalloc SearchDictionaryMatch[16];
            int count = CollectMatches(source, matches);
            for (int i = 0; i < count; i++)
            {
                if (matches[i].ByteLength == source.Length)
                {
                    match = matches[i];
                    return true;
                }
            }

            match = default;
            return false;
        }

        public string ResolveUtf8(uint hash)
        {
            foreach (SearchDictionaryEntry entry in _entries)
            {
                ReadOnlySpan<byte> candidate = new(_basePtr + _stringsBaseOffset + entry.StringOffset, entry.ByteLength);
                if (MurmurHash3.HashBytes(candidate) == hash)
                {
                    return Encoding.UTF8.GetString(candidate);
                }
            }

            return hash.ToString(CultureInfo.InvariantCulture);
        }

        public void Dispose()
        {
            if (_basePtr is not null)
            {
                _handle.ReleasePointer();
                _basePtr = null;
            }

            _view.Dispose();
            _mmf.Dispose();
        }

        private static int CollectTrieMatches(
            ReadOnlySpan<byte> source,
            Span<SearchDictionaryMatch> matches,
            SearchDictionaryNode[] nodes,
            SearchDictionaryEdge[] edges,
            SearchDictionaryEntry[] entries)
        {
            if (source.IsEmpty || nodes.Length == 0)
            {
                return 0;
            }

            int count = 0;
            uint state = 0;
            for (int offset = 0; offset < source.Length;)
            {
                int runeLength = SearchTokenizer.GetUtf8ScalarLength(source[offset]);
                if (runeLength <= 0 || offset + runeLength > source.Length)
                {
                    break;
                }

                uint scalar = SearchTokenizer.DecodeUtf8Scalar(source, offset, runeLength);
                if (!TryFindEdge(nodes, edges, state, scalar, out uint nextState))
                {
                    break;
                }

                state = nextState;
                offset += runeLength;

                uint terminalEntryIndex = nodes[(int)state].TerminalEntryIndex;
                if (terminalEntryIndex == NoSearchDictionaryTerminal)
                {
                    continue;
                }

                if (count >= matches.Length)
                {
                    break;
                }

                SearchDictionaryEntry entry = entries[checked((int)terminalEntryIndex)];
                matches[count++] = new SearchDictionaryMatch(
                    entry.ByteLength,
                    checked((int)entry.RuneLength),
                    entry.Frequency,
                    entry.Stopword);
            }

            if (count > 1)
            {
                matches[..count].Sort(static (left, right) =>
                {
                    int byRunes = right.RuneLength.CompareTo(left.RuneLength);
                    return byRunes != 0 ? byRunes : right.Frequency.CompareTo(left.Frequency);
                });
            }

            return count;
        }

        private static bool TryFindEdge(
            SearchDictionaryNode[] nodes,
            SearchDictionaryEdge[] edges,
            uint state,
            uint scalar,
            out uint nextState)
        {
            SearchDictionaryNode node = nodes[checked((int)state)];
            int low = checked((int)node.FirstEdgeIndex);
            int high = low + checked((int)node.EdgeCount) - 1;
            while (low <= high)
            {
                int mid = low + ((high - low) / 2);
                SearchDictionaryEdge edge = edges[mid];
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

        private sealed class SearchDictionarySnapshot(
            SearchDictionaryNode[] nodes,
            SearchDictionaryEdge[] edges,
            SearchDictionaryEntry[] entries,
            byte[] strings) : ISearchDictionaryLookup
        {
            public int CollectMatches(ReadOnlySpan<byte> source, Span<SearchDictionaryMatch> matches)
                => CollectTrieMatches(source, matches, nodes, edges, entries);

            public bool TryFindExactMatch(ReadOnlySpan<byte> source, out SearchDictionaryMatch match)
            {
                Span<SearchDictionaryMatch> matches = stackalloc SearchDictionaryMatch[16];
                int count = CollectMatches(source, matches);
                for (int i = 0; i < count; i++)
                {
                    if (matches[i].ByteLength == source.Length)
                    {
                        match = matches[i];
                        return true;
                    }
                }

                match = default;
                return false;
            }

            public string ResolveUtf8(uint hash)
            {
                foreach (SearchDictionaryEntry entry in entries)
                {
                    ReadOnlySpan<byte> candidate = strings.AsSpan((int)entry.StringOffset, entry.ByteLength);
                    if (MurmurHash3.HashBytes(candidate) == hash)
                    {
                        return Encoding.UTF8.GetString(candidate);
                    }
                }

                return hash.ToString(CultureInfo.InvariantCulture);
            }
        }
    }

    private const uint NoSearchDictionaryTerminal = uint.MaxValue;

    private readonly record struct SearchDictionaryTrieBuild(SearchDictionaryNode[] Nodes, SearchDictionaryEdge[] Edges);
    private readonly record struct SearchDictionaryNode(uint FirstEdgeIndex, uint EdgeCount, uint TerminalEntryIndex);
    private readonly record struct SearchDictionaryEdge(uint Scalar, uint TargetNodeIndex);
    private readonly record struct SearchDictionaryEntry(uint StringOffset, ushort ByteLength, uint Frequency, uint RuneLength, bool Stopword);
    private readonly record struct SearchDictionaryMatch(int ByteLength, int RuneLength, uint Frequency, bool Stopword);

    private static class MurmurHash3
    {
        [MethodImpl(MethodImplOptions.AggressiveInlining)]
        public static uint HashBytes(ReadOnlySpan<byte> bytes)
        {
            const uint c1 = 0xcc9e2d51;
            const uint c2 = 0x1b873593;
            uint h1 = 0;
            int length = bytes.Length;
            int roundedEnd = length & ~0x3;

            for (int i = 0; i < roundedEnd; i += 4)
            {
                uint k1 = (uint)(bytes[i]
                    | bytes[i + 1] << 8
                    | bytes[i + 2] << 16
                    | bytes[i + 3] << 24);

                k1 *= c1;
                k1 = BitOperations.RotateLeft(k1, 15);
                k1 *= c2;

                h1 ^= k1;
                h1 = BitOperations.RotateLeft(h1, 13);
                h1 = h1 * 5 + 0xe6546b64;
            }

            uint tail = 0;
            switch (length & 3)
            {
                case 3:
                    tail ^= (uint)bytes[roundedEnd + 2] << 16;
                    goto case 2;
                case 2:
                    tail ^= (uint)bytes[roundedEnd + 1] << 8;
                    goto case 1;
                case 1:
                    tail ^= bytes[roundedEnd];
                    tail *= c1;
                    tail = BitOperations.RotateLeft(tail, 15);
                    tail *= c2;
                    h1 ^= tail;
                    break;
            }

            h1 ^= (uint)length;
            h1 ^= h1 >> 16;
            h1 *= 0x85ebca6b;
            h1 ^= h1 >> 13;
            h1 *= 0xc2b2ae35;
            h1 ^= h1 >> 16;
            return h1;
        }
    }
}
