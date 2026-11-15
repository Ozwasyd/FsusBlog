using System.Buffers.Binary;
using System.Numerics;
using System.Text;

using static FsusBlog.V2.Contracts.WireLayouts;

namespace FsusBlog.V2.Contracts;

public readonly record struct LocalSearchCorpusPage(int Number, int DocumentCount, int FirstArticleId, int LastArticleId, byte[] Bytes);

/// <summary>Builds bounded FSPK v4 pages from the current public article projection.</summary>
public static class LocalSearchCorpus
{
    private static readonly UTF8Encoding Utf8 = new(false, true);
    private const int PageBytes = WireLimits.SearchCorpusPageBytes;
    private const int MaxStagedPages = 512;
    private const int MaxStagedAggregateBytes = 256 * 1024 * 1024;
    private const int PostingBudgetBytes = 40;
    private const int PositionBudgetBytes = 7;
    private const byte TitleField = 1;
    private const byte BodyField = 4;

    public static IReadOnlyList<byte[]>? Build(IReadOnlyList<Article> articles, CancellationToken ct = default)
    {
        var pages = new List<byte[]>();
        return TryStagePages(articles, WireLimits.SearchCorpusMaxPages, WireLimits.SearchCorpusTotalBytes, page =>
        {
            pages.Add(page.Bytes);
            return true;
        }, ct) ? pages.AsReadOnly() : null;
    }

    /// <summary>Emits consecutive encoded pages to an unpublished stage. A rejected page stops the build.
    /// Discard the stage if the method returns false or throws.</summary>
    public static bool TryStagePages(IReadOnlyList<Article> articles, int maxPages, int maxAggregateBytes,
        Func<LocalSearchCorpusPage, bool> stage, CancellationToken ct = default)
    {
        ArgumentNullException.ThrowIfNull(articles);
        ArgumentNullException.ThrowIfNull(stage);
        if (maxPages is < 1 or > MaxStagedPages) throw new ArgumentOutOfRangeException(nameof(maxPages));
        if (maxAggregateBytes is < 1 or > MaxStagedAggregateBytes) throw new ArgumentOutOfRangeException(nameof(maxAggregateBytes));
        ct.ThrowIfCancellationRequested();
        // Every page holds at most this many documents even when the byte budget would fit more.
        if (articles.Count > checked(maxPages * WireLimits.SearchIndexPageSize)) return false;

        var docs = new List<Document>();
        using var postingBytes = new MemoryStream();
        using var strings = new MemoryStream();
        var projectedBytes = 0;
        var byteCount = 0;
        var pageCount = 0;
        var lastId = 0;

        foreach (var article in articles.OrderBy(article => article.Id))
        {
            ct.ThrowIfCancellationRequested();
            if (article.Id <= lastId)
                throw new ProtocolException("Invalid or duplicate search corpus article ID");
            lastId = article.Id;
            var doc = Index(article, ct);
            if (doc is null) return false;
            // Bound both the exact encoded size and the construction before merging term dictionaries.
            var estimate = doc.EstimatedBytes;
            if (docs.Count != 0 && (projectedBytes + estimate > PageBytes - 512 ||
                                      docs.Count >= WireLimits.SearchIndexPageSize))
            {
                if (!StagePage()) return false;
                docs.Clear();
                projectedBytes = 0;
            }
            docs.Add(doc);
            projectedBytes += estimate;
        }

        return StagePage();

        bool StagePage()
        {
            ct.ThrowIfCancellationRequested();
            if (pageCount >= maxPages) return false;
            postingBytes.SetLength(0);
            strings.SetLength(0);
            var page = Package(docs, postingBytes, strings, ct);
            if (page is null || page.Length > maxAggregateBytes - byteCount) return false;
            byteCount += page.Length;
            var firstId = docs.Count == 0 ? 0 : docs[0].Article.Id;
            var lastId = docs.Count == 0 ? 0 : docs[^1].Article.Id;
            var staged = stage(new LocalSearchCorpusPage(++pageCount, docs.Count, firstId, lastId, page));
            ct.ThrowIfCancellationRequested();
            return staged;
        }
    }

    private sealed record Document(Article Article, Dictionary<uint, Frequencies> Terms, int Length, int EstimatedBytes);
    private record struct Frequencies(int Title, int Meta, int Body, List<Position>? Positions);
    private readonly record struct Position(int Offset, byte Field, int Width);
    private readonly record struct Token(uint Hash, int Width, int Advance, bool Stopword = false);
    private readonly record struct Posting(int ArticleId, Frequencies Tf);
    private readonly record struct Term(uint Hash, float Idf, int Offset, int Length, bool HasPositions);
    private readonly record struct TextSlice(int Offset, int Length);
    private readonly record struct Taxon(int Id, TextSlice Name);

    private static Document? Index(Article article, CancellationToken ct)
    {
        if (article.Revision <= 0 || article.RevisionNo <= 0 || article.Publication <= 0 ||
            article.PublicationNo <= 0 || article.PublishedAt.ToUnixTimeMilliseconds() == 0)
            throw new ProtocolException("Search corpus requires a current published article");

        var tags = article.Tags ?? [];
        var summary = article.Summary ?? string.Empty;
        var textBytes = Utf8.GetByteCount(article.Title) + Utf8.GetByteCount(summary) +
                        (article.Category is { } category ? SearchDictionaryRecordSize + Utf8.GetByteCount(category.Name) : 0) +
                        tags.Sum(tag => SearchDictionaryRecordSize + 2 + Utf8.GetByteCount(tag.Name));
        if (article.Title.Length == 0 || article.Title.Contains('\0') || Utf8.GetByteCount(article.Title) > WireLimits.TitleBytes ||
            Utf8.GetByteCount(summary) > 2048 || Utf8.GetByteCount(article.Body) > WireLimits.BodyBytes ||
            tags.Count > WireLimits.TaxonomyTagCount ||
            tags.Any(tag => tag.Id <= 0 || Utf8.GetByteCount(tag.Name) > WireLimits.TaxonomyNameBytes) ||
            article.Category is { } value && (value.Id <= 0 || Utf8.GetByteCount(value.Name) > WireLimits.TaxonomyNameBytes))
            throw new ProtocolException("Search corpus text exceeds its limits");

        var terms = new Dictionary<uint, Frequencies>();
        var length = 0;
        var positions = 0;
        var tokens = 0;
        if (!Field(article.Title, TitleField) || !Field(summary, 0) ||
            !Field(article.Category?.Name ?? string.Empty, 0) ||
            tags.Any(tag => !Field(tag.Name, 0)) || !Field(article.Body, BodyField))
            return null;

        return new Document(article, terms, Math.Max(1, length), Estimate());

        int Estimate() => SearchDocumentRecordSize + textBytes +
            terms.Count * PostingBudgetBytes + positions * PositionBudgetBytes;

        bool Field(string text, byte field)
        {
            var offset = 0;
            foreach (var token in Tokens(text))
            {
                if ((tokens++ & 1023) == 0) ct.ThrowIfCancellationRequested();
                terms.TryGetValue(token.Hash, out var old);
                if (!token.Stopword && (field is TitleField or BodyField))
                {
                    (old.Positions ??= []).Add(new Position(offset, field, token.Width));
                    positions++;
                }
                offset += token.Advance;
                terms[token.Hash] = field switch
                {
                    TitleField => old with { Title = old.Title + 1 },
                    BodyField => old with { Body = old.Body + 1 },
                    _ => old with { Meta = old.Meta + 1 }
                };
                if (Estimate() > PageBytes - 512) return false;
            }
            length += offset;
            return true;
        }
    }

    private static byte[]? Package(IReadOnlyList<Document> docs, MemoryStream postingBytes, MemoryStream strings,
        CancellationToken ct)
    {
        var index = new SortedDictionary<uint, List<Posting>>();
        foreach (var doc in docs)
        {
            ct.ThrowIfCancellationRequested();
            foreach (var (hash, frequency) in doc.Terms)
            {
                if (!index.TryGetValue(hash, out var postings)) index.Add(hash, postings = []);
                postings.Add(new Posting(doc.Article.Id, frequency));
            }
        }

        var terms = new List<Term>(index.Count);
        foreach (var (hash, postings) in index)
        {
            ct.ThrowIfCancellationRequested();
            var start = checked((int)postingBytes.Position);
            Varint(postingBytes, postings.Count);
            var previous = 0;
            var hasPositions = false;
            foreach (var posting in postings)
            {
                Varint(postingBytes, posting.ArticleId - previous);
                previous = posting.ArticleId;
                postingBytes.WriteByte(Quantize(posting.Tf.Title));
                postingBytes.WriteByte(Quantize(posting.Tf.Meta));
                postingBytes.WriteByte(Quantize(posting.Tf.Body));
                var positions = posting.Tf.Positions;
                if (positions is not { Count: > 0 })
                {
                    Varint(postingBytes, 0);
                    continue;
                }
                hasPositions = true;
                positions.Sort(static (first, second) => (first.Offset, first.Field, first.Width)
                    .CompareTo((second.Offset, second.Field, second.Width)));
                var distinct = 1;
                for (var i = 1; i < positions.Count; i++)
                    if (positions[i] != positions[i - 1]) distinct++;
                Varint(postingBytes, distinct);
                var priorPosition = 0;
                for (var i = 0; i < positions.Count; i++)
                {
                    ct.ThrowIfCancellationRequested();
                    var position = positions[i];
                    if (i > 0 && position == positions[i - 1]) continue;
                    Varint(postingBytes, position.Offset - priorPosition);
                    Varint(postingBytes, position.Width);
                    Varint(postingBytes, position.Field);
                    priorPosition = position.Offset;
                }
            }
            var idf = (float)Math.Log(1 + (docs.Count - postings.Count + 0.5) / (postings.Count + 0.5));
            terms.Add(new Term(hash, idf, start, checked((int)postingBytes.Position - start), hasPositions));
        }

        var categories = DictionaryEntries(docs.Select(d => d.Article.Category).OfType<TaxonomyName>(), strings);
        var tags = DictionaryEntries(docs.SelectMany(d => d.Article.Tags ?? []), strings);
        if (categories.Count >= ushort.MaxValue || tags.Count >= ushort.MaxValue) return null;
        var categoryIndex = categories.Select((entry, i) => (entry.Id, i)).ToDictionary(x => x.Id, x => x.i);
        var tagIndex = tags.Select((entry, i) => (entry.Id, i)).ToDictionary(x => x.Id, x => x.i);

        var metadata = new (TextSlice Title, TextSlice Summary)[docs.Count];
        var tagRefs = new List<ushort>();
        for (var i = 0; i < docs.Count; i++)
        {
            var article = docs[i].Article;
            metadata[i] = (Append(strings, article.Title), Append(strings, article.Summary ?? string.Empty));
            foreach (var tag in article.Tags ?? [])
                tagRefs.Add((ushort)tagIndex[tag.Id]);
        }

        const int termStart = SearchShardHeaderSize;
        var docStart = Align(termStart + terms.Count * SearchTermRecordSize);
        var categoryStart = Align(docStart + docs.Count * SearchDocumentRecordSize);
        var tagStart = Align(categoryStart + categories.Count * SearchDictionaryRecordSize);
        var tagRefStart = Align(tagStart + tags.Count * SearchDictionaryRecordSize);
        var stringStart = Align(tagRefStart + tagRefs.Count * 2);
        var postingStart = Align(checked(stringStart + (int)strings.Length));
        var shardSize = checked(postingStart + (int)postingBytes.Length);
        if (shardSize > PageBytes - SearchPackagePayloadOffset) return null;

        var package = new byte[SearchPackagePayloadOffset + shardSize];
        I32(package, 0, SearchPackageMagic);
        I32(package, 4, SearchArtifactVersion);
        I32(package, 8, 1);
        I32(package, SearchPackageEntryOffset + 8, SearchPackagePayloadOffset);
        I32(package, SearchPackageEntryOffset + 12, shardSize);

        var shard = package.AsSpan(SearchPackagePayloadOffset);
        var fields = new[]
        {
            SearchShardMagic, SearchArtifactVersion, 0, 1, terms.Count, docs.Count, categories.Count,
            tags.Count, tagRefs.Count, termStart, docStart, categoryStart, tagStart, tagRefStart,
            stringStart, postingStart, checked((int)postingBytes.Length)
        };
        for (var i = 0; i < fields.Length; i++) I32(shard, i * 4, fields[i]);
        F32(shard, 68, docs.Count == 0 ? 1 : (float)docs.Average(doc => (double)doc.Length));

        for (var i = 0; i < terms.Count; i++)
        {
            var row = shard[(termStart + i * SearchTermRecordSize)..];
            var term = terms[i];
            I32(row, 0, unchecked((int)term.Hash));
            F32(row, 4, term.Idf);
            I32(row, 8, term.Offset);
            I32(row, 12, term.Length);
            I32(row, 16, term.HasPositions ? 1 : 0);
        }

        var tagOffset = 0;
        for (var i = 0; i < docs.Count; i++)
        {
            var row = shard[(docStart + i * SearchDocumentRecordSize)..];
            var doc = docs[i];
            var value = doc.Article;
            var tagCount = value.Tags?.Count ?? 0;
            I32(row, 0, value.Id);
            U16(row, 4, value.Category is { } category ? categoryIndex[category.Id] : ushort.MaxValue);
            U16(row, 6, tagCount);
            I32(row, 8, tagOffset);
            I32(row, 20, doc.Length);
            I64(row, 24, value.PublishedAt.ToUnixTimeMilliseconds());
            WriteString(row, 32, metadata[i].Title);
            WriteString(row, 40, metadata[i].Summary);
            I64(row, 52, value.Revision);
            I32(row, 60, value.RevisionNo);
            I64(row, 64, value.Publication);
            I32(row, 72, value.PublicationNo);
            tagOffset += tagCount;
        }

        WriteDictionary(shard, categoryStart, categories);
        WriteDictionary(shard, tagStart, tags);
        for (var i = 0; i < tagRefs.Count; i++) U16(shard, tagRefStart + i * 2, tagRefs[i]);
        strings.GetBuffer().AsSpan(0, checked((int)strings.Length)).CopyTo(shard[stringStart..]);
        postingBytes.GetBuffer().AsSpan(0, checked((int)postingBytes.Length)).CopyTo(shard[postingStart..]);
        return package;
    }

    private static List<Taxon> DictionaryEntries(IEnumerable<TaxonomyName> items, MemoryStream strings)
    {
        var result = new List<Taxon>();
        foreach (var group in items.GroupBy(item => item.Id).OrderBy(group => group.Key))
        {
            var first = group.First();
            if (group.Any(item => item.Name != first.Name))
                throw new ProtocolException("Conflicting public taxonomy names");
            result.Add(new Taxon(first.Id, Append(strings, first.Name)));
        }
        return result;
    }

    private static TextSlice Append(MemoryStream strings, string value)
    {
        var length = Utf8.GetByteCount(value);
        if (length == 0) return default;
        var offset = checked((int)strings.Position);
        strings.SetLength(checked(offset + length));
        Utf8.GetBytes(value.AsSpan(), strings.GetBuffer().AsSpan(offset, length));
        strings.Position = offset + length;
        return new TextSlice(offset, length);
    }

    private static void WriteDictionary(Span<byte> shard, int start, List<Taxon> entries)
    {
        for (var i = 0; i < entries.Count; i++)
        {
            var row = shard[(start + i * SearchDictionaryRecordSize)..];
            I32(row, 0, entries[i].Id);
            WriteString(row, 4, entries[i].Name);
        }
    }

    private static void WriteString(Span<byte> row, int offset, TextSlice value)
    {
        I32(row, offset, value.Offset);
        U16(row, offset + 4, value.Length);
    }

    private static void Varint(Stream stream, int value)
    {
        while (value >= 128)
        {
            stream.WriteByte((byte)(value | 128));
            value >>= 7;
        }
        stream.WriteByte((byte)value);
    }

    private static byte Quantize(int value) => (byte)(value switch
    {
        <= 10 => value, <= 12 => 11, <= 15 => 12, <= 20 => 13,
        <= 30 => 14, <= 50 => 15, <= 100 => 16, _ => 17
    });

    private static IEnumerable<Token> Tokens(string text)
    {
        text = text.Normalize(NormalizationForm.FormKC);
        for (var index = 0; index < text.Length;)
        {
            if (char.IsAsciiLetterOrDigit(text[index]))
            {
                var start = index++;
                while (index < text.Length && char.IsAsciiLetterOrDigit(text[index])) index++;
                yield return new Token(HashAscii(text.AsSpan(start, index - start)), 1, 1);
            }
            else if (SearchLexicon.IsCjk(text[index]))
            {
                var start = index++;
                while (index < text.Length && SearchLexicon.IsCjk(text[index])) index++;
                foreach (var (at, width) in SearchLexicon.Segment(text, start, index))
                {
                    if (width > 1)
                    {
                        // Keep character matches for readers searching for a name or a fragment.
                        // Dictionary subtokens share the source offsets used by phrase matching.
                        for (var relative = 0; relative < width; relative++)
                        {
                            var available = width - relative;
                            for (var subWidth = Math.Min(width - 1, available); subWidth >= 2; subWidth--)
                            {
                                var subword = text.AsSpan(at + relative, subWidth);
                                if (SearchLexicon.IsWord(subword))
                                    yield return DictionaryToken(subword, 0);
                            }
                            if (relative == 0)
                                yield return DictionaryToken(text.AsSpan(at, width), 0);
                            yield return DictionaryToken(text.AsSpan(at + relative, 1), 1);
                        }
                    }
                    else yield return DictionaryToken(text.AsSpan(at, 1), 1);
                }
            }
            else
            {
                var scalar = Rune.GetRuneAt(text, index);
                index += scalar.Utf16SequenceLength;
                if (scalar.Value >= 0x80 && Rune.IsLetterOrDigit(scalar))
                    yield return new Token(HashRune(scalar), 1, 1);
            }
        }
    }

    private static Token DictionaryToken(ReadOnlySpan<char> word, int advance) =>
        new(HashWord(word), word.Length, advance, SearchLexicon.IsStopword(word));

    internal static uint HashWord(ReadOnlySpan<char> word)
    {
        if (word.Length == 1) return HashRune(new Rune(word[0]));
        Span<byte> bytes = stackalloc byte[word.Length * 3];
        var length = Utf8.GetBytes(word, bytes);
        uint hash = 0;
        var offset = 0;
        for (; length - offset >= 4; offset += 4)
            hash = MixWord(hash, BinaryPrimitives.ReadUInt32LittleEndian(bytes[offset..]));
        uint tail = 0;
        for (var i = 0; offset + i < length; i++) tail |= (uint)bytes[offset + i] << (8 * i);
        return FinishHash(hash, tail, length);
    }

    internal static uint HashAscii(ReadOnlySpan<char> token)
    {
        uint hash = 0;
        var offset = 0;
        while (token.Length - offset >= 4)
        {
            var word = LowerAscii(token[offset]) | (LowerAscii(token[offset + 1]) << 8) |
                (LowerAscii(token[offset + 2]) << 16) | (LowerAscii(token[offset + 3]) << 24);
            hash = MixWord(hash, word);
            offset += 4;
        }
        uint tail = 0;
        for (var i = 0; offset + i < token.Length; i++)
            tail |= LowerAscii(token[offset + i]) << (8 * i);
        return FinishHash(hash, tail, token.Length);
    }

    internal static uint HashRune(Rune rune)
    {
        Span<byte> encoded = stackalloc byte[4];
        var bytes = encoded[..rune.EncodeToUtf8(encoded)];
        uint hash = 0;
        var offset = bytes.Length == 4 ? 4 : 0;
        if (offset == 4) hash = MixWord(0, BinaryPrimitives.ReadUInt32LittleEndian(bytes));
        uint tail = 0;
        for (var i = 0; offset + i < bytes.Length; i++)
            tail |= (uint)bytes[offset + i] << (8 * i);
        return FinishHash(hash, tail, bytes.Length);
    }

    private static uint LowerAscii(char value) => (uint)(value is >= 'A' and <= 'Z' ? value + ('a' - 'A') : value);
    private static uint MixWord(uint hash, uint word) => BitOperations.RotateLeft(hash ^ Mix(word), 13) * 5 + 0xe6546b64;

    private static uint FinishHash(uint hash, uint tail, int length)
    {
        hash ^= Mix(tail) ^ (uint)length;
        hash = (hash ^ (hash >> 16)) * 0x85ebca6b;
        hash = (hash ^ (hash >> 13)) * 0xc2b2ae35;
        return hash ^ (hash >> 16);
    }

    private static uint Mix(uint value) => BitOperations.RotateLeft(value * 0xcc9e2d51, 15) * 0x1b873593;
    private static int Align(int value) => (value + 7) & ~7;
    private static void I32(Span<byte> b, int offset, int v) => BinaryPrimitives.WriteInt32LittleEndian(b[offset..], v);
    private static void I64(Span<byte> b, int offset, long v) => BinaryPrimitives.WriteInt64LittleEndian(b[offset..], v);
    private static void U16(Span<byte> b, int offset, int v) => BinaryPrimitives.WriteUInt16LittleEndian(b[offset..], checked((ushort)v));
    private static void F32(Span<byte> b, int offset, float v) => BinaryPrimitives.WriteSingleLittleEndian(b[offset..], v);
}
