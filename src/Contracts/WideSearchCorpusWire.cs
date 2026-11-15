using System.Buffers.Binary;
using System.Security.Cryptography;

namespace FsusBlog.V2.Contracts;

public readonly record struct WideSearchCorpusPage(int Number, int DocumentCount, int FirstArticleId, int LastArticleId,
    long Offset, int Length, string Sha256);

public sealed record WideSearchCorpusManifest(int DocumentCount, long ByteCount, string ContentDigest,
    IReadOnlyList<WideSearchCorpusPage> Pages);

public static class WideSearchCorpusWire
{
    private const int DigestOffset = 28;
    private const int FspkHeaderSize = WireLayouts.SearchPackagePayloadOffset + WireLayouts.SearchShardHeaderSize;

    public static WideSearchCorpusManifest Seal(int documentCount, long byteCount, IReadOnlyList<WideSearchCorpusPage> pages)
    {
        var descriptors = CopyPages(pages);
        var entries = new byte[descriptors.Length * WireLayouts.SearchWideManifestPageRecordSize];
        WriteEntries(documentCount, byteCount, descriptors, entries);
        var digest = Digest(documentCount, byteCount, descriptors.Length, entries);
        return new WideSearchCorpusManifest(documentCount, byteCount, Convert.ToHexStringLower(digest),
            Array.AsReadOnly(descriptors));
    }

    public static byte[] Encode(long generation, WideSearchCorpusManifest manifest)
    {
        ArgumentNullException.ThrowIfNull(manifest);
        if (generation < 0 || !IsSha256(manifest.ContentDigest))
            throw new ProtocolException("Invalid wide search corpus generation or manifest digest.");

        var descriptors = CopyPages(manifest.Pages);
        var payload = new byte[WireLayouts.SearchWideManifestHeaderSize +
            descriptors.Length * WireLayouts.SearchWideManifestPageRecordSize];
        var entries = payload.AsSpan(WireLayouts.SearchWideManifestHeaderSize);
        WriteEntries(manifest.DocumentCount, manifest.ByteCount, descriptors, entries);
        var digest = Digest(manifest.DocumentCount, manifest.ByteCount, descriptors.Length, entries);
        if (!string.Equals(Convert.ToHexStringLower(digest), manifest.ContentDigest, StringComparison.Ordinal))
            throw new ProtocolException("Wide search corpus manifest digest does not match its pages.");

        BinaryPrimitives.WriteInt32LittleEndian(payload, WireLayouts.SearchWideManifestVersion);
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(4), generation);
        WriteTotals(payload.AsSpan(12), manifest.DocumentCount, descriptors.Length, manifest.ByteCount);
        digest.CopyTo(payload.AsSpan(DigestOffset));
        return Aeds.Encode(FrameType.PublicSearchWideManifest, payload);
    }

    private static WideSearchCorpusPage[] CopyPages(IReadOnlyList<WideSearchCorpusPage> pages)
    {
        ArgumentNullException.ThrowIfNull(pages);
        var count = pages.Count;
        if (count is < 1 or > WireLimits.SearchWideCorpusMaxPages)
            throw new ProtocolException("Invalid wide search corpus page count.");

        var copy = new WideSearchCorpusPage[count];
        for (var i = 0; i < copy.Length; i++)
            copy[i] = pages[i];
        return copy;
    }

    private static void WriteEntries(int documentCount, long byteCount, ReadOnlySpan<WideSearchCorpusPage> pages, Span<byte> entries)
    {
        if (documentCount < 0 || documentCount > pages.Length * WireLimits.SearchIndexPageSize ||
            byteCount is < FspkHeaderSize or > WireLimits.SearchWideCorpusTotalBytes)
            throw new ProtocolException("Invalid wide search corpus totals.");

        var documents = 0;
        var lastId = 0;
        var offset = 0L;
        for (var i = 0; i < pages.Length; i++)
        {
            var page = pages[i];
            if (page.Number != i + 1 || page.Offset != offset ||
                page.DocumentCount is < 0 or > WireLimits.SearchIndexPageSize ||
                page.DocumentCount > documentCount - documents ||
                page.Length < FspkHeaderSize + page.DocumentCount * WireLayouts.SearchDocumentRecordSize ||
                page.Length > WireLimits.SearchCorpusPageBytes || page.Length > byteCount - offset ||
                !HasArticleRange(page, documentCount, lastId) || !IsSha256(page.Sha256))
                throw new ProtocolException("Invalid wide search corpus page descriptor.");

            var entry = entries[(i * WireLayouts.SearchWideManifestPageRecordSize)..];
            BinaryPrimitives.WriteInt32LittleEndian(entry, page.Number);
            BinaryPrimitives.WriteInt32LittleEndian(entry[4..], page.DocumentCount);
            BinaryPrimitives.WriteInt32LittleEndian(entry[8..], page.FirstArticleId);
            BinaryPrimitives.WriteInt32LittleEndian(entry[12..], page.LastArticleId);
            BinaryPrimitives.WriteInt64LittleEndian(entry[16..], page.Offset);
            BinaryPrimitives.WriteInt32LittleEndian(entry[24..], page.Length);
            Convert.FromHexString(page.Sha256).CopyTo(entry[DigestOffset..]);
            offset += page.Length;
            documents += page.DocumentCount;
            lastId = page.LastArticleId;
        }

        if (documents != documentCount || offset != byteCount)
            throw new ProtocolException("Wide search corpus pages do not match the declared totals.");
    }

    private static bool HasArticleRange(WideSearchCorpusPage page, int documentCount, int lastId) =>
        page.DocumentCount == 0
            ? documentCount == 0 && page.Number == 1 && page.Length == FspkHeaderSize &&
                page.FirstArticleId == 0 && page.LastArticleId == 0
            : page.FirstArticleId > lastId &&
                (page.DocumentCount == 1
                    ? page.LastArticleId == page.FirstArticleId
                    : (long)page.LastArticleId - page.FirstArticleId + 1 >= page.DocumentCount);

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(char.IsAsciiHexDigitLower);

    private static byte[] Digest(int documentCount, long byteCount, int pageCount, ReadOnlySpan<byte> entries)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("public-search-fspk-manifest-v1\0"u8);
        Span<byte> totals = stackalloc byte[16];
        WriteTotals(totals, documentCount, pageCount, byteCount);
        hash.AppendData(totals);
        hash.AppendData(entries);
        return hash.GetHashAndReset();
    }

    private static void WriteTotals(Span<byte> destination, int documentCount, int pageCount, long byteCount)
    {
        BinaryPrimitives.WriteInt32LittleEndian(destination, documentCount);
        BinaryPrimitives.WriteInt32LittleEndian(destination[4..], pageCount);
        BinaryPrimitives.WriteInt64LittleEndian(destination[8..], byteCount);
    }
}
