using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using SqlSugar;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Frozen;
using System.Collections.Immutable;
using System.Globalization;
using System.IO.MemoryMappedFiles;
using Microsoft.Win32.SafeHandles;
using System.Numerics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging.Abstractions;
using System.Diagnostics;

namespace FsusBlog.Server.Services;

public sealed partial class SearchIndexService
{
    private static SearchIndexManifest? ReadManifest(string path)
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            return DecodeManifest(File.ReadAllBytes(path));
        }
        catch
        {
            return null;
        }
    }

    private static byte[] EncodeManifest(SearchIndexManifest manifest)
    {
        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream, Encoding.UTF8, leaveOpen: true);
        writer.Write(SearchManifestMagic);
        writer.Write(SearchManifestBinaryVersion);
        writer.Write(manifest.SchemaVersion);
        writer.Write(manifest.GeneratedAt.ToUniversalTime().Ticks);
        WriteManifestString(writer, manifest.CurrentVersion);
        writer.Write(manifest.Shards.Count);
        foreach (SearchShardManifest shard in manifest.Shards)
        {
            writer.Write((uint)shard.Role);
            WriteManifestString(writer, shard.FullUrl);
            WriteManifestString(writer, shard.FullSha256);
            WriteNullableManifestString(writer, shard.PatchUrl);
            WriteNullableManifestString(writer, shard.PatchSha256);
            writer.Write(shard.LoadPhase);
        }

        WriteManifestStringList(writer, manifest.InitialRoles);
        WriteManifestStringList(writer, manifest.BackgroundRoles);
        WriteManifestStringList(writer, manifest.DeepRoles);
        writer.Flush();
        return stream.ToArray();
    }

    private static SearchIndexManifest? DecodeManifest(byte[] payload)
    {
        try
        {
            using var stream = new MemoryStream(payload, writable: false);
            using var reader = new BinaryReader(stream, Encoding.UTF8, leaveOpen: false);
            if (reader.ReadUInt32() != SearchManifestMagic ||
                reader.ReadUInt32() != SearchManifestBinaryVersion)
            {
                return null;
            }

            int schemaVersion = reader.ReadInt32();
            DateTime generatedAt = new(reader.ReadInt64(), DateTimeKind.Utc);
            string currentVersion = ReadManifestString(reader);
            int shardCount = reader.ReadInt32();
            if (shardCount < 0 || shardCount > 32)
            {
                return null;
            }

            var shards = new List<SearchShardManifest>(shardCount);
            for (int i = 0; i < shardCount; i++)
            {
                SearchShardRole role = (SearchShardRole)reader.ReadUInt32();
                if (!Enum.IsDefined(role))
                {
                    return null;
                }

                shards.Add(new SearchShardManifest(
                    role,
                    ReadManifestString(reader),
                    ReadManifestString(reader),
                    ReadNullableManifestString(reader),
                    ReadNullableManifestString(reader),
                    reader.ReadInt32()));
            }

            SearchIndexManifest manifest = new(
                schemaVersion,
                currentVersion,
                generatedAt,
                shards,
                ReadManifestStringList(reader),
                ReadManifestStringList(reader),
                ReadManifestStringList(reader));

            return stream.Position == stream.Length ? manifest : null;
        }
        catch (EndOfStreamException)
        {
            return null;
        }
        catch (IOException)
        {
            return null;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static void WriteManifestStringList(BinaryWriter writer, IReadOnlyList<string> values)
    {
        writer.Write(values.Count);
        foreach (string value in values)
        {
            WriteManifestString(writer, value);
        }
    }

    private static IReadOnlyList<string> ReadManifestStringList(BinaryReader reader)
    {
        int count = reader.ReadInt32();
        if (count < 0 || count > 32)
        {
            throw new ArgumentException("Invalid search manifest string list count.");
        }

        var values = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            values.Add(ReadManifestString(reader));
        }

        return values;
    }

    private static void WriteNullableManifestString(BinaryWriter writer, string? value)
    {
        writer.Write(value is not null);
        if (value is not null)
        {
            WriteManifestString(writer, value);
        }
    }

    private static string? ReadNullableManifestString(BinaryReader reader)
        => reader.ReadBoolean() ? ReadManifestString(reader) : null;

    private static void WriteManifestString(BinaryWriter writer, string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        writer.Write(bytes.Length);
        writer.Write(bytes);
    }

    private static string ReadManifestString(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > 4096)
        {
            throw new ArgumentException("Invalid search manifest string length.");
        }

        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length)
        {
            throw new EndOfStreamException();
        }

        return Encoding.UTF8.GetString(bytes);
    }

    private static void WriteFileAtomically(string path, byte[] bytes)
    {
        string temp = Path.Combine(
            Path.GetDirectoryName(path)!,
            $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temp, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                BufferSize = 81920,
                Options = FileOptions.WriteThrough
            }))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }

            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            File.Delete(temp);
        }
    }

    private static string ComputeVersion(params byte[][] payloads)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (byte[] payload in payloads)
        {
            hash.AppendData(payload);
        }

        return ToLowerHex(hash.GetHashAndReset())[..16];
    }

    private static string ToLowerHex(byte[] value)
        => Convert.ToHexStringLower(value);

    private static SearchCategoryDictionary BuildCategoryDictionary(List<SearchSourceArticle> articles)
    {
        var byId = new Dictionary<int, SearchCategoryDictionaryEntry>();
        foreach (SearchSourceArticle article in articles)
        {
            byId.TryAdd(article.CategoryId, new SearchCategoryDictionaryEntry(article.CategoryId, article.CategoryName));
        }

        SearchCategoryDictionaryEntry[] entries = byId.Values.OrderBy(it => it.OriginalCategoryId).ToArray();
        var index = new Dictionary<int, ushort>(entries.Length);
        for (ushort i = 0; i < entries.Length; i++)
        {
            index[entries[i].OriginalCategoryId] = i;
        }

        return new SearchCategoryDictionary(entries.ToImmutableArray(), index.ToFrozenDictionary());
    }

    private static SearchTagDictionary BuildTagDictionary(List<SearchSourceArticle> articles)
    {
        var byId = new Dictionary<int, SearchTagDictionaryEntry>();
        foreach (SearchSourceArticle article in articles)
        {
            foreach (SearchTagItem tag in article.Tags)
            {
                byId.TryAdd(tag.Id, new SearchTagDictionaryEntry(tag.Id, tag.Name));
            }
        }

        SearchTagDictionaryEntry[] entries = byId.Values.OrderBy(it => it.OriginalTagId).ToArray();
        var index = new Dictionary<int, ushort>(entries.Length);
        for (ushort i = 0; i < entries.Length; i++)
        {
            index[entries[i].OriginalTagId] = i;
        }

        return new SearchTagDictionary(entries.ToImmutableArray(), index.ToFrozenDictionary());
    }

    private static ImmutableArray<SearchDocEntry> BuildDocEntries(
        List<SearchSourceArticle> articles,
        FrozenDictionary<int, ushort> categoryIndex,
        FrozenDictionary<int, ushort> tagIndex)
    {
        var docs = ImmutableArray.CreateBuilder<SearchDocEntry>(articles.Count);
        foreach (SearchSourceArticle article in articles.OrderBy(it => it.Id))
        {
            ushort[] tagRefs = article.Tags
                .Select(tag => tagIndex.TryGetValue(tag.Id, out ushort value) ? value : (ushort)0)
                .ToArray();

            docs.Add(new SearchDocEntry(
                article.Id,
                categoryIndex.TryGetValue(article.CategoryId, out ushort categoryRef) ? categoryRef : (ushort)0,
                new DateTimeOffset(article.CreateTime).ToUnixTimeMilliseconds(),
                article.Views,
                article.CommentCount,
                article.DocLength,
                article.Title,
                article.Summary,
                tagRefs));
        }

        return docs.MoveToImmutable();
    }

    private SearchShardData BuildShard(
        SearchShardRole role,
        List<SearchSourceArticle> articles,
        SearchDictionaryRuntime dictionary,
        SearchCategoryDictionary categoryDictionary,
        SearchTagDictionary tagDictionary,
        ImmutableArray<SearchDocEntry> allDocs,
        Func<SearchSourceArticle, bool> articlePredicate,
        bool includeDocMetadata,
        bool includeCoreFields,
        bool includeBodyField)
    {
        SearchSourceArticle[] selectedArticles = articles
            .Where(articlePredicate)
            .OrderBy(it => it.Id)
            .ToArray();

        var accumulators = new Dictionary<uint, TermAccumulator>();
        int totalDocLength = 0;
        foreach (SearchSourceArticle article in selectedArticles)
        {
            if (includeCoreFields)
            {
                EnumerateFieldTokens(dictionary, article.Title, SearchFieldKind.Title, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                EnumerateFieldTokens(dictionary, article.Summary, SearchFieldKind.Summary, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                EnumerateFieldTokens(dictionary, article.CategoryName, SearchFieldKind.Meta, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                foreach (SearchTagItem tag in article.Tags)
                {
                    EnumerateFieldTokens(dictionary, tag.Name, SearchFieldKind.Meta, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
                }
            }

            if (includeBodyField)
            {
                EnumerateFieldTokens(dictionary, article.Body, SearchFieldKind.Body, static (token, state) => state.AddToken(token), new TokenEmissionContext(article.Id, accumulators));
            }

            totalDocLength += Math.Max(article.DocLength, 1);
        }

        int dfCutoff = ResolveDocumentFrequencyCutoff(accumulators, selectedArticles.Length);
        SearchTermEntry[] terms = BuildTerms(accumulators, selectedArticles.Length, dfCutoff);
        ImmutableArray<SearchDocEntry> docs = includeDocMetadata
            ? FilterDocsBySelectedArticles(allDocs, selectedArticles)
            : selectedArticles.Select(article => SearchDocEntry.Minimal(article.Id)).ToImmutableArray();

        float avgDocLength = selectedArticles.Length == 0 ? 1f : Math.Max((float)totalDocLength / selectedArticles.Length, 1f);
        return new SearchShardData(role, docs, categoryDictionary.Entries, tagDictionary.Entries, terms, BuildForwardIndex(terms), avgDocLength);
    }

    private static FrozenDictionary<int, SearchForwardTermEntry[]> BuildForwardIndex(SearchTermEntry[] terms)
    {
        var forward = new Dictionary<int, List<SearchForwardTermEntry>>();
        foreach (SearchTermEntry term in terms)
        {
            foreach (SearchPostingEntry posting in term.Postings)
            {
                int articleId = checked((int)posting.ArticleId);
                if (!forward.TryGetValue(articleId, out List<SearchForwardTermEntry>? entries))
                {
                    entries = [];
                    forward[articleId] = entries;
                }

                entries.Add(new SearchForwardTermEntry(term.Hash, term.Idf, term.HasPositions, posting));
            }
        }

        return forward.ToDictionary(
                static entry => entry.Key,
                static entry => entry.Value
                    .OrderBy(static term => term.TermHash)
                    .ToArray())
            .ToFrozenDictionary();
    }

    private static ImmutableArray<SearchDocEntry> FilterDocsBySelectedArticles(
        ImmutableArray<SearchDocEntry> allDocs,
        SearchSourceArticle[] selectedArticles)
    {
        if (selectedArticles.Length == 0 || allDocs.Length == 0)
        {
            return [];
        }

        var selectedIds = new HashSet<int>(selectedArticles.Length);
        for (int i = 0; i < selectedArticles.Length; i++)
        {
            selectedIds.Add(selectedArticles[i].Id);
        }

        var docs = ImmutableArray.CreateBuilder<SearchDocEntry>(selectedArticles.Length);
        foreach (SearchDocEntry doc in allDocs)
        {
            if (selectedIds.Contains(doc.ArticleId))
            {
                docs.Add(doc);
            }
        }

        return docs.MoveToImmutable();
    }

    private static int ResolveDocumentFrequencyCutoff(Dictionary<uint, TermAccumulator> accumulators, int documentCount)
    {
        if (accumulators.Count == 0 || documentCount <= 0)
        {
            return int.MaxValue;
        }

        int percentileIndex = Math.Clamp(
            (int)Math.Floor((accumulators.Count - 1) * (HotFrequencyPercentile / 100d)),
            0,
            accumulators.Count - 1);
        int[] histogram = ArrayPool<int>.Shared.Rent(documentCount + 1);
        try
        {
            histogram.AsSpan(0, documentCount + 1).Clear();
            foreach (TermAccumulator accumulator in accumulators.Values)
            {
                int df = Math.Clamp(accumulator.DocumentFrequency, 0, documentCount);
                histogram[df]++;
            }

            int seen = 0;
            for (int df = 0; df <= documentCount; df++)
            {
                seen += histogram[df];
                if (seen > percentileIndex)
                {
                    return df;
                }
            }

            return documentCount;
        }
        finally
        {
            ArrayPool<int>.Shared.Return(histogram, clearArray: false);
        }
    }

    private static SearchTermEntry[] BuildTerms(Dictionary<uint, TermAccumulator> accumulators, int docCount, int dfCutoff)
    {
        uint[] hashes = accumulators.Keys.ToArray();
        Array.Sort(hashes);
        var terms = new SearchTermEntry[hashes.Length];
        for (int i = 0; i < hashes.Length; i++)
        {
            uint hash = hashes[i];
            TermAccumulator accumulator = accumulators[hash];
            bool keepPositions = ShouldKeepPositions(accumulator.DocumentFrequency, dfCutoff, accumulator.Stopword, accumulator.KeepPositions);
            SearchPostingEntry[] postings = accumulator.Postings.Values
                .OrderBy(it => it.ArticleId)
                .Select(posting => posting.Build(keepPositions))
                .ToArray();
            terms[i] = new SearchTermEntry(hash, ComputeIdf(docCount, accumulator.DocumentFrequency), keepPositions, postings);
        }

        return terms;
    }

    private static float ComputeIdf(int docCount, int df)
    {
        if (docCount <= 0 || df <= 0)
        {
            return 0f;
        }

        return (float)Math.Log(1d + ((docCount - df + 0.5d) / (df + 0.5d)));
    }

    private static bool ShouldKeepPositions(int documentFrequency, int dfCutoff, bool stopword, bool keepPositionsCandidate)
        => keepPositionsCandidate
            && !stopword
            && documentFrequency > 0
            && documentFrequency < dfCutoff;

    private static bool ShouldEmitPatch(
        int shardDocCount,
        int patchDocCount,
        int tombstoneCount,
        int patchBytesLength,
        int shardBytesLength)
    {
        if (patchDocCount <= 0 && tombstoneCount <= 0)
        {
            return false;
        }

        int safeDocCount = Math.Max(shardDocCount, 1);
        int safeShardBytes = Math.Max(shardBytesLength, 1);
        if (patchDocCount * 100 > safeDocCount * PatchRebuildDocThresholdPercent)
        {
            return false;
        }

        if (tombstoneCount * 100 > safeDocCount * PatchRebuildTombstoneThresholdPercent)
        {
            return false;
        }

        if (patchBytesLength * 100 > safeShardBytes * PatchRebuildByteThresholdPercent)
        {
            return false;
        }

        return true;
    }

    private static void EnumerateFieldTokens<TState>(
        ISearchDictionaryLookup dictionary,
        string? text,
        SearchFieldKind field,
        Action<SearchToken, TState> consumer,
        TState state)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        int byteCount = Encoding.UTF8.GetByteCount(text);
        byte[]? rented = null;
        Span<byte> buffer = byteCount <= 1024
            ? stackalloc byte[byteCount]
            : (rented = ArrayPool<byte>.Shared.Rent(byteCount)).AsSpan(0, byteCount);

        try
        {
            Encoding.UTF8.GetBytes(text.AsSpan(), buffer);
            var tokenizer = new SearchTokenizer(dictionary, field, buffer[..byteCount]);
            while (tokenizer.MoveNext(out SearchToken token))
            {
                consumer(token, state);
            }
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented, clearArray: true);
            }
        }
    }

    private static byte[] SerializeShard(SearchShardData shard)
    {
        var termMetadata = new TermMetadataRecord[shard.Terms.Length];
        int postingLength = 0;

        for (int termIndex = 0; termIndex < shard.Terms.Length; termIndex++)
        {
            SearchTermEntry term = shard.Terms[termIndex];
            int postingStart = postingLength;
            postingLength += CountVInt(checked((uint)term.Postings.Length));
            uint previousArticleId = 0u;
            foreach (SearchPostingEntry posting in term.Postings)
            {
                postingLength += CountVInt(posting.ArticleId - previousArticleId);
                previousArticleId = posting.ArticleId;
                postingLength += 3;
                postingLength += CountVInt(checked((uint)posting.Positions.Length));

                uint previousPosition = 0u;
                foreach (SearchPositionEntry position in posting.Positions)
                {
                    postingLength += CountVInt(position.Position - previousPosition);
                    postingLength += CountVInt(position.PositionLength);
                    postingLength += CountVInt((uint)position.Field);
                    previousPosition = position.Position;
                }
            }

            termMetadata[termIndex] = new TermMetadataRecord(term.Hash, term.Idf, (uint)postingStart, (uint)(postingLength - postingStart), term.HasPositions);
        }

        var categoryMetadata = new DictionaryMetadataRecord[shard.Categories.Length];
        int stringPoolLength = 0;
        for (int i = 0; i < shard.Categories.Length; i++)
        {
            SearchCategoryDictionaryEntry entry = shard.Categories[i];
            uint stringOffset = (uint)stringPoolLength;
            int byteCount = Encoding.UTF8.GetByteCount(entry.Name);
            stringPoolLength += byteCount;
            categoryMetadata[i] = new DictionaryMetadataRecord(entry.OriginalCategoryId, stringOffset, (ushort)byteCount);
        }

        var tagMetadata = new DictionaryMetadataRecord[shard.Tags.Length];
        for (int i = 0; i < shard.Tags.Length; i++)
        {
            SearchTagDictionaryEntry entry = shard.Tags[i];
            uint stringOffset = (uint)stringPoolLength;
            int byteCount = Encoding.UTF8.GetByteCount(entry.Name);
            stringPoolLength += byteCount;
            tagMetadata[i] = new DictionaryMetadataRecord(entry.OriginalTagId, stringOffset, (ushort)byteCount);
        }

        var docMetadata = new DocMetadataRecord[shard.Documents.Length];
        int tagRefsBytesLength = 0;
        for (int i = 0; i < shard.Documents.Length; i++)
        {
            SearchDocEntry doc = shard.Documents[i];
            uint docTagRefOffset = (uint)(tagRefsBytesLength / sizeof(ushort));
            tagRefsBytesLength += doc.TagRefs.Length * sizeof(ushort);

            uint titleOffset = 0;
            ushort titleLength = 0;
            if (!string.IsNullOrEmpty(doc.Title))
            {
                titleOffset = (uint)stringPoolLength;
                titleLength = checked((ushort)Encoding.UTF8.GetByteCount(doc.Title));
                stringPoolLength += titleLength;
            }

            uint summaryOffset = 0;
            ushort summaryLength = 0;
            if (!string.IsNullOrEmpty(doc.Summary))
            {
                summaryOffset = (uint)stringPoolLength;
                summaryLength = checked((ushort)Encoding.UTF8.GetByteCount(doc.Summary));
                stringPoolLength += summaryLength;
            }

            docMetadata[i] = new DocMetadataRecord(
                (uint)doc.ArticleId,
                doc.CategoryDictionaryIndex,
                (ushort)doc.TagRefs.Length,
                docTagRefOffset,
                (uint)doc.Views,
                (uint)doc.CommentCount,
                (uint)Math.Max(doc.DocLength, 1),
                doc.PublishUnixMs,
                titleOffset,
                titleLength,
                summaryOffset,
                summaryLength);
        }

        int termOffset = Align(HeaderSize, 8);
        int docOffset = Align(termOffset + termMetadata.Length * TermMetadataSize, 8);
        int categoryOffset = Align(docOffset + docMetadata.Length * DocMetadataSize, 8);
        int tagOffset = Align(categoryOffset + categoryMetadata.Length * DictionaryMetadataSize, 8);
        int tagRefOffset = Align(tagOffset + tagMetadata.Length * DictionaryMetadataSize, 8);
        int stringPoolOffset = Align(tagRefOffset + tagRefsBytesLength, 8);
        int postingOffset = Align(stringPoolOffset + stringPoolLength, 8);
        int totalLength = postingOffset + postingLength;

        byte[] buffer = new byte[totalLength];
        Span<byte> span = buffer;
        int offset = 0;
        WriteUInt32(span, ref offset, ShardMagic);
        WriteUInt32(span, ref offset, SearchShardVersion);
        WriteUInt32(span, ref offset, (uint)shard.Role);
        WriteUInt32(span, ref offset, shard.Role == SearchShardRole.Core ? 1u : 0u);
        WriteUInt32(span, ref offset, (uint)termMetadata.Length);
        WriteUInt32(span, ref offset, (uint)docMetadata.Length);
        WriteUInt32(span, ref offset, (uint)categoryMetadata.Length);
        WriteUInt32(span, ref offset, (uint)tagMetadata.Length);
        WriteUInt32(span, ref offset, (uint)(tagRefsBytesLength / sizeof(ushort)));
        WriteUInt32(span, ref offset, (uint)termOffset);
        WriteUInt32(span, ref offset, (uint)docOffset);
        WriteUInt32(span, ref offset, (uint)categoryOffset);
        WriteUInt32(span, ref offset, (uint)tagOffset);
        WriteUInt32(span, ref offset, (uint)tagRefOffset);
        WriteUInt32(span, ref offset, (uint)stringPoolOffset);
        WriteUInt32(span, ref offset, (uint)postingOffset);
        WriteUInt32(span, ref offset, (uint)postingLength);
        WriteSingle(span, ref offset, shard.AverageDocLength);
        offset = termOffset;

        foreach (TermMetadataRecord term in termMetadata)
        {
            WriteUInt32(span, ref offset, term.Hash);
            WriteSingle(span, ref offset, term.Idf);
            WriteUInt32(span, ref offset, term.PostingOffset);
            WriteUInt32(span, ref offset, term.PostingLength);
            WriteUInt32(span, ref offset, term.HasPositions ? 1u : 0u);
            WriteUInt32(span, ref offset, 0);
        }

        offset = docOffset;
        foreach (DocMetadataRecord doc in docMetadata)
        {
            WriteUInt32(span, ref offset, doc.ArticleId);
            WriteUInt16(span, ref offset, doc.CategoryIndex);
            WriteUInt16(span, ref offset, doc.TagCount);
            WriteUInt32(span, ref offset, doc.TagRefOffset);
            WriteUInt32(span, ref offset, doc.Views);
            WriteUInt32(span, ref offset, doc.CommentCount);
            WriteUInt32(span, ref offset, doc.DocLength);
            WriteInt64(span, ref offset, doc.PublishUnixMs);
            WriteUInt32(span, ref offset, doc.TitleOffset);
            WriteUInt16(span, ref offset, doc.TitleLength);
            WriteUInt16(span, ref offset, 0);
            WriteUInt32(span, ref offset, doc.SummaryOffset);
            WriteUInt16(span, ref offset, doc.SummaryLength);
            WriteUInt16(span, ref offset, 0);
            WriteUInt32(span, ref offset, 0);
        }

        offset = categoryOffset;
        foreach (DictionaryMetadataRecord entry in categoryMetadata)
        {
            WriteUInt32(span, ref offset, (uint)entry.OriginalId);
            WriteUInt32(span, ref offset, entry.StringOffset);
            WriteUInt16(span, ref offset, entry.StringLength);
            WriteUInt16(span, ref offset, 0);
            WriteUInt32(span, ref offset, 0);
        }

        offset = tagOffset;
        foreach (DictionaryMetadataRecord entry in tagMetadata)
        {
            WriteUInt32(span, ref offset, (uint)entry.OriginalId);
            WriteUInt32(span, ref offset, entry.StringOffset);
            WriteUInt16(span, ref offset, entry.StringLength);
            WriteUInt16(span, ref offset, 0);
            WriteUInt32(span, ref offset, 0);
        }

        offset = tagRefOffset;
        foreach (SearchDocEntry doc in shard.Documents)
        {
            foreach (ushort tagRef in doc.TagRefs)
            {
                WriteUInt16(span, ref offset, tagRef);
            }
        }

        offset = stringPoolOffset;
        foreach (SearchCategoryDictionaryEntry entry in shard.Categories)
        {
            WriteUtf8(span, ref offset, entry.Name, Encoding.UTF8.GetByteCount(entry.Name));
        }

        foreach (SearchTagDictionaryEntry entry in shard.Tags)
        {
            WriteUtf8(span, ref offset, entry.Name, Encoding.UTF8.GetByteCount(entry.Name));
        }

        foreach (SearchDocEntry doc in shard.Documents)
        {
            if (!string.IsNullOrEmpty(doc.Title))
            {
                WriteUtf8(span, ref offset, doc.Title, Encoding.UTF8.GetByteCount(doc.Title));
            }

            if (!string.IsNullOrEmpty(doc.Summary))
            {
                WriteUtf8(span, ref offset, doc.Summary, Encoding.UTF8.GetByteCount(doc.Summary));
            }
        }

        offset = postingOffset;
        foreach (SearchTermEntry term in shard.Terms)
        {
            WriteVInt(span, ref offset, checked((uint)term.Postings.Length));
            uint previousArticleId = 0u;
            foreach (SearchPostingEntry posting in term.Postings)
            {
                WriteVInt(span, ref offset, posting.ArticleId - previousArticleId);
                previousArticleId = posting.ArticleId;
                span[offset++] = posting.TitleTf;
                span[offset++] = posting.MetaTf;
                span[offset++] = posting.BodyTf;
                WriteVInt(span, ref offset, checked((uint)posting.Positions.Length));

                uint previousPosition = 0u;
                foreach (SearchPositionEntry position in posting.Positions)
                {
                    WriteVInt(span, ref offset, position.Position - previousPosition);
                    WriteVInt(span, ref offset, position.PositionLength);
                    WriteVInt(span, ref offset, (uint)position.Field);
                    previousPosition = position.Position;
                }
            }
        }

        return buffer;
    }

    private static byte[] BuildPackage(ReadOnlySpan<SearchPackageEntry> entries)
    {
        const int packageHeaderSize = 12;
        const int entryHeaderSize = 16;
        int offset = Align(packageHeaderSize + entries.Length * entryHeaderSize, 8);
        int[] offsets = new int[entries.Length];
        for (int i = 0; i < entries.Length; i++)
        {
            offsets[i] = offset;
            offset = Align(offset + entries[i].Bytes.Length, 8);
        }

        using var writer = new PooledByteBufferWriter(offset + 64);
        WriteUInt32(writer, PackageMagic);
        WriteUInt32(writer, SearchPackageVersion);
        WriteUInt32(writer, (uint)entries.Length);
        AlignWriter(writer, packageHeaderSize);

        for (int i = 0; i < entries.Length; i++)
        {
            SearchPackageEntry entry = entries[i];
            WriteUInt32(writer, (uint)entry.Kind);
            WriteUInt32(writer, (uint)entry.Role);
            WriteUInt32(writer, (uint)offsets[i]);
            WriteUInt32(writer, (uint)entry.Bytes.Length);
        }

        for (int i = 0; i < entries.Length; i++)
        {
            AlignWriter(writer, offsets[i]);
            writer.Write(entries[i].Bytes);
        }

        return writer.ToArray();
    }

    private static void AlignWriter(IBufferWriter<byte> writer, int targetOffset)
    {
        if (writer is not PooledByteBufferWriter pooled)
        {
            throw new InvalidOperationException("Only pooled buffer writers are supported for aligned writes.");
        }

        int padding = targetOffset - pooled.WrittenCount;
        if (padding <= 0)
        {
            return;
        }

        pooled.GetSpan(padding).Slice(0, padding).Clear();
        pooled.Advance(padding);
    }

    private static int Align(int value, int alignment)
        => (value + alignment - 1) & ~(alignment - 1);

    private static int CountVInt(uint value)
    {
        int count = 1;
        while (value >= 0x80)
        {
            count++;
            value >>= 7;
        }

        return count;
    }

    private static void WriteUInt32(Span<byte> destination, ref int offset, uint value)
    {
        BinaryPrimitives.WriteUInt32LittleEndian(destination[offset..], value);
        offset += sizeof(uint);
    }

    private static void WriteUInt16(Span<byte> destination, ref int offset, ushort value)
    {
        BinaryPrimitives.WriteUInt16LittleEndian(destination[offset..], value);
        offset += sizeof(ushort);
    }

    private static void WriteInt64(Span<byte> destination, ref int offset, long value)
    {
        BinaryPrimitives.WriteInt64LittleEndian(destination[offset..], value);
        offset += sizeof(long);
    }

    private static void WriteSingle(Span<byte> destination, ref int offset, float value)
        => WriteUInt32(destination, ref offset, BitConverter.SingleToUInt32Bits(value));

    private static void WriteUtf8(Span<byte> destination, ref int offset, string value, int byteCount)
    {
        if (byteCount == 0)
        {
            return;
        }

        int written = Encoding.UTF8.GetBytes(value.AsSpan(), destination.Slice(offset, byteCount));
        offset += written;
    }

    private static void WriteVInt(Span<byte> destination, ref int offset, uint value)
    {
        while (value >= 0x80)
        {
            destination[offset++] = (byte)(value | 0x80);
            value >>= 7;
        }

        destination[offset++] = (byte)value;
    }

    private static void WriteUInt32(IBufferWriter<byte> destination, uint value)
    {
        Span<byte> span = destination.GetSpan(sizeof(uint));
        BinaryPrimitives.WriteUInt32LittleEndian(span, value);
        destination.Advance(sizeof(uint));
    }

    private static void WriteUInt16(IBufferWriter<byte> destination, ushort value)
    {
        Span<byte> span = destination.GetSpan(sizeof(ushort));
        BinaryPrimitives.WriteUInt16LittleEndian(span, value);
        destination.Advance(sizeof(ushort));
    }

    private static void WriteInt64(IBufferWriter<byte> destination, long value)
    {
        Span<byte> span = destination.GetSpan(sizeof(long));
        BinaryPrimitives.WriteInt64LittleEndian(span, value);
        destination.Advance(sizeof(long));
    }

    private static void WriteSingle(IBufferWriter<byte> destination, float value)
        => WriteUInt32(destination, BitConverter.SingleToUInt32Bits(value));

    private static void WriteUtf8(IBufferWriter<byte> destination, string value, int byteCount)
    {
        if (byteCount == 0)
        {
            return;
        }

        Span<byte> span = destination.GetSpan(byteCount);
        int written = Encoding.UTF8.GetBytes(value.AsSpan(), span);
        destination.Advance(written);
    }

    private static void WriteVInt(IBufferWriter<byte> writer, uint value)
    {
        while (value >= 0x80)
        {
            Span<byte> span = writer.GetSpan(1);
            span[0] = (byte)(value | 0x80);
            writer.Advance(1);
            value >>= 7;
        }

        Span<byte> final = writer.GetSpan(1);
        final[0] = (byte)value;
        writer.Advance(1);
    }

}
