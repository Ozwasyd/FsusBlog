using System.Buffers.Binary;
using FsusBlog.V2.Contracts;

internal static class PublishedArticleMediaVectors
{
    internal static void Run()
    {
        var key = Guid.Parse("00112233-4455-6677-8899-aabbccddeeff");
        var asset = Guid.Parse("fedcba98-7654-3210-0123-456789abcdef");
        const long revision = 0x0102030405060708;
        var commandBytes = Convert.FromHexString("21000000080706050403020100112233445566778899aabbccddeeff01000000" +
            "fedcba98765432100123456789abcdef");
        var commandFrame = Wire.EncodeArticlePublishImages(new(33, revision, key, [asset]));
        Equal(commandBytes, Aeds.Decode(commandFrame, FrameType.ArticlePublishImages), "Selected images command");
        var command = Wire.DecodeArticlePublishImages(Aeds.Encode(FrameType.ArticlePublishImages, commandBytes));
        if (command.ArticleId != 33 || command.ExpectedRevision != revision || command.IdempotencyKey != key ||
            !command.AssetIds.SequenceEqual([asset]))
            throw new InvalidOperationException("Selected images command decoded incorrectly.");

        const string digest = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
        var image = new PublishedArticleImage(digest, 2, 1024, 1600, 900);
        var manifestBytes = Convert.FromHexString("21000000080706050403020101000000" + digest + "02000000000400004006000084030000");
        var manifestFrame = Wire.EncodePublicArticleMedia(new(33, revision, [image]));
        Equal(manifestBytes, Aeds.Decode(manifestFrame, FrameType.PublicArticleMedia), "Public article image manifest");
        var manifest = Wire.DecodePublicArticleMedia(Aeds.Encode(FrameType.PublicArticleMedia, manifestBytes));
        if (manifest.ArticleId != 33 || manifest.Publication != revision || !manifest.Images.SequenceEqual([image]))
            throw new InvalidOperationException("Public article image manifest decoded incorrectly.");

        Reject(() => Wire.DecodeArticlePublishImages(Aeds.Encode(FrameType.ArticlePublishImages, commandBytes.AsSpan(0, 47))));
        Reject(() => Wire.EncodeArticlePublishImages(new(33, revision, key, [asset, asset])));
        Reject(() => Wire.DecodePublicArticleMedia(Aeds.Encode(FrameType.PublicArticleMedia, [.. manifestBytes, 0])));
        Reject(() => Wire.EncodePublicArticleMedia(new(33, revision, [image with { Width = 8192, Height = 8192 }])));
        Reject(() => Wire.EncodePublicArticleMedia(new(33, revision, [image, image])));
        BinaryPrimitives.WriteInt32LittleEndian(manifestBytes.AsSpan(12), 0);
        Equal(manifestBytes.AsSpan(0, 16), Aeds.Decode(Wire.EncodePublicArticleMedia(new(33, revision, [])),
            FrameType.PublicArticleMedia), "Empty current publication manifest");
    }

    private static void Equal(ReadOnlySpan<byte> expected, ReadOnlySpan<byte> actual, string what)
    {
        if (!expected.SequenceEqual(actual))
            throw new InvalidOperationException($"{what} differs from its pinned wire layout.");
    }

    private static void Reject(Action action) =>
        ProtocolRejection.Assert(action, "Invalid published media data was accepted.");
}
