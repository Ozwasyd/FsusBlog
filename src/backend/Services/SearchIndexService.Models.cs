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
    private sealed record SearchIndexManifest(
        int SchemaVersion,
        string CurrentVersion,
        DateTime GeneratedAt,
        IReadOnlyList<SearchShardManifest> Shards,
        IReadOnlyList<string> InitialRoles,
        IReadOnlyList<string> BackgroundRoles,
        IReadOnlyList<string> DeepRoles);

    private sealed record SearchShardManifest(
        SearchShardRole Role,
        string FullUrl,
        string FullSha256,
        string? PatchUrl,
        string? PatchSha256,
        int LoadPhase);

    private sealed record SearchBuildArtifacts(
        string Version,
        DateTime GeneratedAt,
        SearchShardArtifact[] Shards,
        byte[] AliasPackage);

    private sealed record SearchShardArtifact(SearchShardRole Role, SearchShardData Data, byte[] Bytes);

    private sealed record SearchSourceArticle
    {
        public int Id
        {
            get; init;
        }
        public string Title { get; init; } = string.Empty;
        public string Summary { get; init; } = string.Empty;
        public string Body { get; init; } = string.Empty;
        public int CategoryId
        {
            get; init;
        }
        public string CategoryName { get; init; } = string.Empty;
        public List<SearchTagItem> Tags { get; init; } = [];
        public int Views
        {
            get; init;
        }
        public int CommentCount
        {
            get; init;
        }
        public DateTime CreateTime
        {
            get; init;
        }
        public DateTime PublishedAt
        {
            get; init;
        }
        public int DocLength
        {
            get; init;
        }
        public long RevisionId
        {
            get; init;
        }
        public int RevisionNo
        {
            get; init;
        }
        public long PublicationId
        {
            get; init;
        }
        public int PublicationNo
        {
            get; init;
        }
    }

    private sealed record SearchArticleRow
    {
        public int Id
        {
            get; init;
        }
        public string? Title
        {
            get; init;
        }
        public string? Summary
        {
            get; init;
        }
        public int CategoryId
        {
            get; init;
        }
        public string? CategoryName
        {
            get; init;
        }
        public int Views
        {
            get; init;
        }
        public DateTime CreateTime
        {
            get; init;
        }
        public string MarkdownContent { get; init; } = string.Empty;
        public string TagIds { get; init; } = string.Empty;
        public long RevisionId
        {
            get; init;
        }
        public int RevisionNo
        {
            get; init;
        }
        public long PublicationId
        {
            get; init;
        }
        public int PublicationNo
        {
            get; init;
        }
        public DateTime PublishedAt
        {
            get; init;
        }
    }

    private sealed record SearchTagRow
    {
        public int ArticleId
        {
            get; init;
        }
        public int TagId
        {
            get; init;
        }
        public string? TagName
        {
            get; init;
        }
    }

    private sealed record SearchCommentCountRow
    {
        public int ArticleId
        {
            get; init;
        }
        public int Count
        {
            get; init;
        }
    }

    private sealed record SearchArticleResultRow
    {
        public int Id
        {
            get; init;
        }
        public string? Title
        {
            get; init;
        }
        public string? Summary
        {
            get; init;
        }
    }

    private sealed record SearchTagItem(int Id, string Name);

    private sealed record SearchCategoryDictionary(ImmutableArray<SearchCategoryDictionaryEntry> Entries, FrozenDictionary<int, ushort> IndexByCategoryId);
    private sealed record SearchCategoryDictionaryEntry(int OriginalCategoryId, string Name);
    private sealed record SearchTagDictionary(ImmutableArray<SearchTagDictionaryEntry> Entries, FrozenDictionary<int, ushort> IndexByTagId);
    private sealed record SearchTagDictionaryEntry(int OriginalTagId, string Name);

    private sealed record SearchShardData(
        SearchShardRole Role,
        ImmutableArray<SearchDocEntry> Documents,
        ImmutableArray<SearchCategoryDictionaryEntry> Categories,
        ImmutableArray<SearchTagDictionaryEntry> Tags,
        SearchTermEntry[] Terms,
        FrozenDictionary<int, SearchForwardTermEntry[]> ForwardIndex,
        float AverageDocLength);

    private sealed record SearchDocEntry(
        int ArticleId,
        ushort CategoryDictionaryIndex,
        long PublishUnixMs,
        int Views,
        int CommentCount,
        int DocLength,
        string Title,
        string Summary,
        ushort[] TagRefs)
    {
        public long RevisionId
        {
            get; init;
        }
        public int RevisionNo
        {
            get; init;
        }
        public long PublicationId
        {
            get; init;
        }
        public int PublicationNo
        {
            get; init;
        }

        public static SearchDocEntry Minimal(int articleId)
            => new(articleId, 0, 0, 0, 0, 1, string.Empty, string.Empty, []);
    }

    private sealed record SearchTermEntry(uint Hash, float Idf, bool HasPositions, SearchPostingEntry[] Postings);
    private readonly record struct SearchForwardTermEntry(uint TermHash, float Idf, bool HasPositions, SearchPostingEntry Posting);
    private sealed record SearchPostingEntry(uint ArticleId, byte TitleTf, byte MetaTf, byte BodyTf, SearchPositionEntry[] Positions);
    private readonly record struct SearchPositionEntry(uint Position, uint PositionLength, SearchFieldKind Field);

    private readonly record struct SearchToken(uint Hash, ulong Fingerprint, SearchFieldKind Field, uint Position, uint PositionLength, bool Stopword, bool KeepPositionsCandidate);

    private enum SearchFieldKind : byte
    {
        Title = 1,
        Summary = 2,
        Meta = 3,
        Body = 4
    }

    private enum SearchShardRole : uint
    {
        Core = 0,
        Recent = 1,
        Archive = 2
    }

    private enum SearchPackageEntryKind : uint
    {
        Shard = 0,
        Patch = 1
    }

    private readonly record struct SearchPackageEntry(SearchPackageEntryKind Kind, SearchShardRole Role, byte[] Bytes);
    private readonly record struct TermMetadataRecord(uint Hash, float Idf, uint PostingOffset, uint PostingLength, bool HasPositions);
    private readonly record struct DictionaryMetadataRecord(int OriginalId, uint StringOffset, ushort StringLength);
    private readonly record struct DocMetadataRecord(
        uint ArticleId,
        ushort CategoryIndex,
        ushort TagCount,
        uint TagRefOffset,
        uint Views,
        uint CommentCount,
        uint DocLength,
        long PublishUnixMs,
        uint TitleOffset,
        ushort TitleLength,
        uint SummaryOffset,
        ushort SummaryLength,
        long RevisionId,
        int RevisionNo,
        long PublicationId,
        int PublicationNo);

    private sealed class TermAccumulator
    {
        private bool _hasFingerprint;
        private ulong _fingerprint;

        public int DocumentFrequency
        {
            get; set;
        }
        public bool Stopword
        {
            get; set;
        }
        public bool KeepPositions
        {
            get; set;
        }
        public Dictionary<int, PostingAccumulator> Postings { get; } = [];

        public void VerifyFingerprint(SearchToken token)
        {
            if (!_hasFingerprint)
            {
                _fingerprint = token.Fingerprint;
                _hasFingerprint = true;
                return;
            }

            if (_fingerprint != token.Fingerprint)
            {
                throw new InvalidDataException($"Search token hash collision detected for hash {token.Hash}.");
            }
        }
    }

    private sealed class PostingAccumulator
    {
        public int ArticleId
        {
            get; init;
        }
        public int TitleTfRaw
        {
            get; set;
        }
        public int MetaTfRaw
        {
            get; set;
        }
        public int BodyTfRaw
        {
            get; set;
        }
        public List<SearchPositionEntry> Positions { get; } = [];

        public SearchPostingEntry Build(bool keepPositions)
            => new(
                (uint)ArticleId,
                QuantizeTf(TitleTfRaw),
                QuantizeTf(MetaTfRaw),
                QuantizeTf(BodyTfRaw),
                BuildPositions(keepPositions));

        private SearchPositionEntry[] BuildPositions(bool keepPositions)
        {
            if (!keepPositions || Positions.Count == 0)
            {
                return [];
            }

            Positions.Sort(static (left, right) => left.Position.CompareTo(right.Position));
            var result = new List<SearchPositionEntry>(Positions.Count);
            SearchPositionEntry? previous = null;
            foreach (SearchPositionEntry current in Positions)
            {
                if (previous.HasValue && previous.Value.Equals(current))
                {
                    continue;
                }

                result.Add(current);
                previous = current;
            }

            return result.ToArray();
        }
    }

    private readonly record struct TokenEmissionContext(int ArticleId, Dictionary<uint, TermAccumulator> Terms)
    {
        public void AddToken(SearchToken token)
        {
            ref TermAccumulator? term = ref CollectionsMarshal.GetValueRefOrAddDefault(Terms, token.Hash, out _);
            term ??= new TermAccumulator();
            term.VerifyFingerprint(token);
            term.Stopword |= token.Stopword;
            term.KeepPositions |= token.KeepPositionsCandidate;

            ref PostingAccumulator? posting = ref CollectionsMarshal.GetValueRefOrAddDefault(term.Postings, ArticleId, out _);
            posting ??= new PostingAccumulator { ArticleId = ArticleId };
            switch (token.Field)
            {
                case SearchFieldKind.Title:
                    posting.TitleTfRaw++;
                    posting.Positions.Add(new SearchPositionEntry(token.Position, token.PositionLength, SearchFieldKind.Title));
                    break;
                case SearchFieldKind.Body:
                    posting.BodyTfRaw++;
                    posting.Positions.Add(new SearchPositionEntry(token.Position, token.PositionLength, SearchFieldKind.Body));
                    break;
                default:
                    posting.MetaTfRaw++;
                    break;
            }

            term.DocumentFrequency = term.Postings.Count;
        }
    }

    private static byte QuantizeTf(int value)
    {
        if (value <= 0)
        {
            return 0;
        }

        if (value <= QuantizedTfMaxExact)
        {
            return (byte)value;
        }

        return value switch
        {
            <= 12 => 11,
            <= 15 => 12,
            <= 20 => 13,
            <= 30 => 14,
            <= 50 => 15,
            <= 100 => 16,
            _ => 17
        };
    }

    internal static byte QuantizeTfForTests(int value)
        => QuantizeTf(value);

    internal static bool ShouldKeepPositionsForTests(int documentFrequency, int dfCutoff, bool stopword, bool keepPositionsCandidate)
        => ShouldKeepPositions(documentFrequency, dfCutoff, stopword, keepPositionsCandidate);

    internal static bool ShouldEmitPatchForTests(
        int shardDocCount,
        int patchDocCount,
        int tombstoneCount,
        int patchBytesLength,
        int shardBytesLength)
        => ShouldEmitPatch(shardDocCount, patchDocCount, tombstoneCount, patchBytesLength, shardBytesLength);

    internal static DateTime NormalizeCreateTimeUtcForTests(DateTime value)
        => NormalizeCreateTimeUtc(value);

    internal static double ComputeRuntimeBm25ForTests(
        double weightedTermFrequency,
        int documentCount,
        int documentFrequency,
        int documentLength,
        double averageDocumentLength)
        => SearchRuntimeScorer.ComputeBm25(weightedTermFrequency, documentCount, documentFrequency, documentLength, averageDocumentLength);

    internal static (int SchemaVersion, string[] InitialRoles, string[] BackgroundRoles, string[] DeepRoles, uint[] ShardRoles) SearchIndexContractForTests()
        => (
            SearchManifestSchemaVersion,
            ["core", "recent"],
            ["archive"],
            [],
            Enum.GetValues<SearchShardRole>().Select(role => (uint)role).ToArray());

    internal static SearchTokenDebugView[] TokenizeForTests(string sourceRoot, string text, string fieldName = "Body")
    {
        string lexiconPath = Path.Combine(sourceRoot, SearchLexiconBinaryFileName);
        SearchDictionaryCompiler.CompileIfNeeded(sourceRoot, lexiconPath, NullLogger<SearchIndexService>.Instance);
        using var dictionary = SearchDictionaryRuntime.Open(lexiconPath);
        if (string.IsNullOrEmpty(text))
        {
            return [];
        }

        SearchFieldKind field = Enum.TryParse<SearchFieldKind>(fieldName, ignoreCase: true, out SearchFieldKind parsed)
            ? parsed
            : SearchFieldKind.Body;

        int byteCount = Encoding.UTF8.GetByteCount(text);
        byte[]? rented = null;
        Span<byte> buffer = byteCount <= 1024
            ? stackalloc byte[byteCount]
            : (rented = ArrayPool<byte>.Shared.Rent(byteCount)).AsSpan(0, byteCount);

        try
        {
            Encoding.UTF8.GetBytes(text.AsSpan(), buffer);
            var tokenizer = new SearchTokenizer(dictionary, field, buffer[..byteCount]);
            var tokens = new List<SearchTokenDebugView>();
            while (tokenizer.MoveNext(out SearchToken token))
            {
                tokens.Add(new SearchTokenDebugView(token.Hash, token.Fingerprint, tokenizer.GetDebugText(token), token.Position, token.PositionLength, token.Stopword, token.KeepPositionsCandidate));
            }

            return [.. tokens];
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented, clearArray: true);
            }
        }
    }

    internal static uint[] RuntimeQueryHashesForTests(string sourceRoot, string keyword)
    {
        string lexiconPath = Path.Combine(sourceRoot, SearchLexiconBinaryFileName);
        SearchDictionaryCompiler.CompileIfNeeded(sourceRoot, lexiconPath, NullLogger<SearchIndexService>.Instance);
        using var dictionary = SearchDictionaryRuntime.Open(lexiconPath);
        return BuildRuntimeQueryHashes(dictionary, keyword);
    }

    internal static int[] RuntimeSearchResultIdsForTests(string sourceRoot, string keyword, params SearchRuntimeTestArticle[] articles)
    {
        string lexiconPath = Path.Combine(sourceRoot, SearchLexiconBinaryFileName);
        SearchDictionaryCompiler.CompileIfNeeded(sourceRoot, lexiconPath, NullLogger<SearchIndexService>.Instance);
        using var dictionary = SearchDictionaryRuntime.Open(lexiconPath);
        List<SearchSourceArticle> sources = articles
            .Select(static article => new SearchSourceArticle
            {
                Id = article.Id,
                Title = article.Title,
                Summary = article.Summary,
                Body = article.Body,
                Views = article.Views,
                CreateTime = article.CreateTime,
                DocLength = Math.Max(1, article.Title.Length + article.Summary.Length + article.Body.Length)
            })
            .ToList();

        SearchRuntimeSnapshot snapshot = SearchRuntimeSnapshot.Build(sources, dictionary);
        return [.. snapshot.Search(keyword).Select(static article => article.Id)];
    }

    internal static bool CanSkipRuntimePostingBlockForTests(
        double topKThreshold,
        double accumulatedDocumentScore,
        double blockMaxScore,
        double remainingQueryMaxScore)
        => CanSkipRuntimePostingBlock(topKThreshold, accumulatedDocumentScore, blockMaxScore, remainingQueryMaxScore);

    internal readonly record struct SearchRuntimeTestArticle(
        int Id,
        string Title,
        string Summary,
        string Body,
        int Views,
        DateTime CreateTime);

    internal readonly record struct SearchTokenDebugView(
        uint Hash,
        ulong Fingerprint,
        string Text,
        uint Position,
        uint PositionLength,
        bool Stopword,
        bool KeepPositionsCandidate);

}
