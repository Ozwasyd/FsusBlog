namespace FsusBlog.V2.Contracts;

public sealed record ArticlePublishImages(int ArticleId, long ExpectedRevision, Guid IdempotencyKey, IReadOnlyList<Guid> AssetIds)
{
    public const int Maximum = 32;
    public const int MaxFrameBytes = Aeds.HeaderSize + 32 + Maximum * 16;
}

public sealed record PublishedArticleImage(string Digest, int Format, int Length, int Width, int Height)
{
    public static bool ValidDigest(string value) => value.Length == 64 && value.All(char.IsAsciiHexDigitLower);

    public static bool MatchesFormat(ReadOnlySpan<byte> bytes, int format) => format switch
    {
        1 => bytes.StartsWith((ReadOnlySpan<byte>)[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        2 => bytes.StartsWith((ReadOnlySpan<byte>)[0xff, 0xd8, 0xff]),
        _ => false
    };

    public bool Valid() => ValidDigest(Digest) && Format is 1 or 2 &&
        Length is >= 1 and <= 20 * 1024 * 1024 && Width is >= 1 and <= 8192 && Height is >= 1 and <= 8192 &&
        (long)Width * Height <= 16 * 1024 * 1024;
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
        var count = reader.I32();
        if (count is < 1 or > ArticlePublishImages.Maximum) throw InvalidPublishImages();
        var assets = new Guid[count];
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
        var count = reader.I32();
        if (count is < 0 or > ArticlePublishImages.Maximum) throw InvalidArticleMedia();
        var images = new PublishedArticleImage[count];
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
