using System.Runtime.InteropServices;

using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class UploadAssetPreviewCodecTests
{
    [Fact]
    public void ClosedHeader_RetainsCanonicalAssetIdentityAndBorrowedBytes()
    {
        Assert.Equal(760, Marshal.SizeOf<UploadAssetPreviewPod>());
        var dto = Fixture();
        byte[] bytes = PodBinaryCodec.EncodeUploadAssetPreview(dto);
        Assert.True(PodBinaryCodec.TryDecodeUploadAssetPreview(bytes, out var decoded));
        Assert.Equal(dto.AssetId, decoded.AssetId);
        Assert.Equal(dto.Bytes.ToArray(), decoded.Bytes.ToArray());
        Assert.Equal(dto.ReferenceLedgerSha256, decoded.ReferenceLedgerSha256);
    }

    [Theory]
    [InlineData(0, 1)]
    [InlineData(100, 65)]
    [InlineData(128, 70)]
    [InlineData(192, 104)]
    [InlineData(448, 65)]
    [InlineData(544, 0)]
    [InlineData(548, 1)]
    [InlineData(555, 128)]
    [InlineData(560, 71)]
    [InlineData(624, 71)]
    [InlineData(688, 71)]
    [InlineData(755, 255)]
    [InlineData(756, 1)]
    public void MalformedFields_FailClosed(int offset, byte replacement)
    {
        byte[] bytes = PodBinaryCodec.EncodeUploadAssetPreview(Fixture());
        bytes[offset] = replacement;
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(bytes, out _));
    }

    [Fact]
    public void TruncationTrailingBytesAndProducerTruncation_AreRejected()
    {
        byte[] bytes = PodBinaryCodec.EncodeUploadAssetPreview(Fixture());
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(bytes[..^1], out _));
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(new byte[759], out _));
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(new byte[761], out _));
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(bytes.Concat(new byte[1]).ToArray(), out _));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeUploadAssetPreview(Fixture() with { PublicUrl = new string('a', 257) }));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeUploadAssetPreview(Fixture() with { Bytes = ReadOnlyMemory<byte>.Empty }));
    }

    private static UploadAssetPreviewDto Fixture() => new()
    {
        UploadId = "0123456789abcdef0123456789abcdef",
        AssetId = "01234567-89ab-cdef-0123-456789abcdef",
        PublicUrl = "/uploads/illustration/0123456789abcdef0123456789abcdef.png",
        MimeType = "image/png",
        Extension = ".png",
        SizeBytes = 1,
        Width = 1,
        Height = 1,
        Sha256 = new string('a', 64),
        AssetVersionSha256 = new string('b', 64),
        ReferenceLedgerSha256 = new string('c', 64),
        Bytes = new byte[] { 255 }
    };
}
