using System.Buffers.Binary;
using System.Globalization;

namespace FsusBlog.V2.Contracts;

public sealed record ArticlePublishImages(int ArticleId, long ExpectedRevision, Guid IdempotencyKey, IReadOnlyList<Guid> AssetIds)
{
    public const int Maximum = 32;
    public const int MaxFrameBytes = Aeds.HeaderSize + 32 + Maximum * 16;
}

public sealed record PublishedArticleImage(string Digest, int Format, int Length, int Width, int Height)
{
    private const int MaximumWebpChunks = 128;

    public static bool ValidDigest(string value) => value.Length == 64 && value.All(char.IsAsciiHexDigitLower);

    public static bool MatchesFormat(ReadOnlySpan<byte> bytes, int format) => format switch
    {
        1 => bytes.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        2 => bytes.StartsWith((ReadOnlySpan<byte>)[0xff, 0xd8, 0xff]),
        3 => IsStaticWebp(bytes),
        _ => false
    };

    public static string FilePath(int article, long publication, string digest)
    {
        if (article <= 0 || publication <= 0 || !ValidDigest(digest))
            throw new ProtocolException("Invalid public image coordinates.");
        return string.Create(CultureInfo.InvariantCulture, $"/public-media/{article}/{publication}/{digest}");
    }

    public bool Valid() => ValidDigest(Digest) && Format is 1 or 2 or 3 &&
        Length is >= 1 and <= 20 * 1024 * 1024 && Width is >= 1 and <= 8192 && Height is >= 1 and <= 8192 &&
        (long)Width * Height <= 16 * 1024 * 1024;

    private static bool IsStaticWebp(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length < 20 || !bytes.StartsWith("RIFF"u8) || !bytes[8..12].SequenceEqual("WEBP"u8) ||
            BinaryPrimitives.ReadUInt32LittleEndian(bytes[4..8]) != bytes.Length - 8) return false;

        var chunks = bytes[12..];
        var hasImage = false;
        for (var chunk = 0; chunks.Length >= 8; chunk++)
        {
            if (chunk == MaximumWebpChunks) return false;
            var tag = chunks[..4];
            var size = BinaryPrimitives.ReadUInt32LittleEndian(chunks[4..8]);
            var padded = (long)size + (size & 1);
            if (padded > chunks.Length - 8 || tag.SequenceEqual("ANIM"u8) || tag.SequenceEqual("ANMF"u8)) return false;
            if (tag.SequenceEqual("VP8X"u8) && (chunk != 0 || size != 10 || (chunks[8] & 0x02) != 0)) return false;
            if (tag.SequenceEqual("VP8 "u8) || tag.SequenceEqual("VP8L"u8))
            {
                if (hasImage || size == 0) return false;
                hasImage = true;
            }

            chunks = chunks[(8 + (int)padded)..];
        }
        return hasImage && chunks.IsEmpty;
    }
}

public sealed record PublicArticleMedia(int ArticleId, long Publication, IReadOnlyList<PublishedArticleImage> Images);

public static partial class Wire
{
    public static byte[] EncodeArticlePublishImages(ArticlePublishImages value)
    {
        ValidatePublishImages(value);
        var writer = new Writer();
        writer.I32(value.ArticleId);
        writer.I64(value.ExpectedRevision);
        writer.Uuid(value.IdempotencyKey);
        writer.I32(value.AssetIds.Count);
        foreach (var asset in value.AssetIds) writer.Uuid(asset);
        return Aeds.Encode(FrameType.ArticlePublishImages, writer.Written);
    }

    public static ArticlePublishImages DecodeArticlePublishImages(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.ArticlePublishImages));
        var article = reader.I32();
        var revision = reader.I64();
        var key = reader.Uuid();
        var assets = new Guid[reader.Count(1, ArticlePublishImages.Maximum, InvalidPublishImages)];
        for (var i = 0; i < assets.Length; i++) assets[i] = reader.Uuid();
        reader.Finish();
        var value = new ArticlePublishImages(article, revision, key, assets);
        ValidatePublishImages(value);
        return value;
    }

    public static byte[] EncodePublicArticleMedia(PublicArticleMedia value)
    {
        ValidatePublicArticleMedia(value);
        var writer = new Writer();
        writer.I32(value.ArticleId);
        writer.I64(value.Publication);
        writer.I32(value.Images.Count);
        foreach (var image in value.Images)
        {
            writer.FixedBytes(Convert.FromHexString(image.Digest));
            writer.I32(image.Format);
            writer.I32(image.Length);
            writer.I32(image.Width);
            writer.I32(image.Height);
        }
        return Aeds.Encode(FrameType.PublicArticleMedia, writer.Written);
    }

    public static PublicArticleMedia DecodePublicArticleMedia(ReadOnlySpan<byte> frame)
    {
        var reader = new Reader(Aeds.Decode(frame, FrameType.PublicArticleMedia));
        var article = reader.I32();
        var publication = reader.I64();
        var images = new PublishedArticleImage[reader.Count(0, ArticlePublishImages.Maximum, InvalidArticleMedia)];
        for (var i = 0; i < images.Length; i++)
            images[i] = new(Convert.ToHexStringLower(reader.FixedBytes(32)), reader.I32(), reader.I32(), reader.I32(), reader.I32());
        reader.Finish();
        var value = new PublicArticleMedia(article, publication, images);
        ValidatePublicArticleMedia(value);
        return value;
    }

    private static void ValidatePublishImages(ArticlePublishImages value)
    {
        if (value.ArticleId <= 0 || value.ExpectedRevision <= 0 || value.IdempotencyKey == Guid.Empty ||
            value.AssetIds.Count is < 1 or > ArticlePublishImages.Maximum || value.AssetIds.Contains(Guid.Empty) ||
            value.AssetIds.Distinct().Count() != value.AssetIds.Count)
            throw InvalidPublishImages();
    }

    private static void ValidatePublicArticleMedia(PublicArticleMedia value)
    {
        if (value.ArticleId <= 0 || value.Publication <= 0 || value.Images.Count > ArticlePublishImages.Maximum)
            throw InvalidArticleMedia();
        var total = 0L;
        var digests = new HashSet<string>(StringComparer.Ordinal);
        foreach (var image in value.Images)
        {
            if (!image.Valid() || !digests.Add(image.Digest) || (total += image.Length) > 40 * 1024 * 1024)
                throw InvalidArticleMedia();
        }
    }

    private static ProtocolException InvalidPublishImages() => new("Invalid published image selection.");
    private static ProtocolException InvalidArticleMedia() => new("Invalid public article images.");
}
