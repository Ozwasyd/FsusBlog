using System.Text;

using static System.Buffers.Binary.BinaryPrimitives;
using static FsusBlog.V2.Contracts.WireLayouts;

namespace FsusBlog.V2.Contracts;

public sealed record ArticleHotItem(int Id, int Views, string Title);

public static class ArticleHotWire
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    public static byte[] Encode(IReadOnlyList<ArticleHotItem> articles) =>
        Aeds.Encode(FrameType.ArticleHot, EncodePayload(articles));

    public static ArticleHotItem[] Decode(ReadOnlySpan<byte> frame) =>
        DecodePayload(Aeds.Decode(frame, FrameType.ArticleHot));

    public static byte[] EncodePayload(IReadOnlyList<ArticleHotItem> articles)
    {
        if (articles.Count > WireLimits.PublicArticleHotMaxSize)
            throw new ProtocolException("Too many popular articles");
        var ids = new HashSet<int>();
        var titles = new byte[articles.Count][];
        var blobSize = 0;
        for (var index = 0; index < articles.Count; index++)
        {
            var item = articles[index];
            ValidateItem(item.Id, item.Views, ids);
            if (item.Title.Length > WireLimits.TitleBytes)
                throw new ProtocolException("Popular article title exceeds its byte limit");
            try { titles[index] = Utf8.GetBytes(item.Title); }
            catch (EncoderFallbackException) { throw new ProtocolException("Invalid popular article title UTF-8"); }
            if (titles[index].Length > WireLimits.TitleBytes)
                throw new ProtocolException("Popular article title exceeds its byte limit");
            blobSize += titles[index].Length;
        }

        var recordsAt = ArticleHotHeaderSize + blobSize;
        var payload = new byte[recordsAt + articles.Count * ArticleHotRecordSize];
        WriteInt32LittleEndian(payload, articles.Count);
        WriteInt32LittleEndian(payload.AsSpan(sizeof(int)), blobSize);
        var offset = 0;
        for (var index = 0; index < articles.Count; index++)
        {
            var item = articles[index];
            var title = titles[index];
            var record = payload.AsSpan(recordsAt + index * ArticleHotRecordSize, ArticleHotRecordSize);
            WriteInt32LittleEndian(record, item.Id);
            WriteInt32LittleEndian(record[ArticleHotViewsOffset..], item.Views);
            WriteInt32LittleEndian(record[ArticleHotTitleOffset..], offset);
            WriteInt32LittleEndian(record[(ArticleHotTitleOffset + sizeof(int))..], title.Length);
            title.AsSpan().CopyTo(payload.AsSpan(ArticleHotHeaderSize + offset, title.Length));
            offset += title.Length;
        }
        return payload;
    }

    public static ArticleHotItem[] DecodePayload(ReadOnlySpan<byte> payload)
    {
        if (payload.Length < ArticleHotHeaderSize)
            throw new ProtocolException("Truncated popular article header");
        var count = ReadInt32LittleEndian(payload);
        var blobSize = ReadInt32LittleEndian(payload[sizeof(int)..]);
        if (count < 0 || count > WireLimits.PublicArticleHotMaxSize || blobSize < 0 || blobSize > count * WireLimits.TitleBytes ||
            payload.Length != ArticleHotHeaderSize + blobSize + count * ArticleHotRecordSize)
            throw new ProtocolException("Invalid popular article payload size");

        var blob = payload.Slice(ArticleHotHeaderSize, blobSize);
        var records = payload[(ArticleHotHeaderSize + blobSize)..];
        var ids = new HashSet<int>();
        var articles = new ArticleHotItem[count];
        var consumed = 0;
        for (var index = 0; index < count; index++)
        {
            var record = records.Slice(index * ArticleHotRecordSize, ArticleHotRecordSize);
            var id = ReadInt32LittleEndian(record);
            var views = ReadInt32LittleEndian(record[ArticleHotViewsOffset..]);
            var offset = ReadInt32LittleEndian(record[ArticleHotTitleOffset..]);
            var length = ReadInt32LittleEndian(record[(ArticleHotTitleOffset + sizeof(int))..]);
            ValidateItem(id, views, ids);
            if (offset != consumed || length < 0 || length > WireLimits.TitleBytes || length > blobSize - consumed)
                throw new ProtocolException("Invalid popular article title range");
            string title;
            try { title = Utf8.GetString(blob.Slice(offset, length)); }
            catch (DecoderFallbackException) { throw new ProtocolException("Invalid popular article title UTF-8"); }
            articles[index] = new(id, views, title);
            consumed += length;
        }
        if (consumed != blobSize)
            throw new ProtocolException("Unused popular article title bytes");
        return articles;
    }

    private static void ValidateItem(int id, int views, HashSet<int> ids)
    {
        if (id <= 0 || views < 0 || !ids.Add(id))
            throw new ProtocolException("Invalid popular article identity or views");
    }
}
