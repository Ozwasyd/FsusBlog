using System.Buffers.Binary;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

public sealed class UploadAssetFactsCodecTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(8_387_832)]
    [InlineData(8_387_833)]
    [InlineData(20_971_520)]
    public void FixedFacts_UseOriginalAssetLimitAndNeverEncodeImageBytes(long size)
    {
        UploadAssetFactsDto value = Fixture(size);
        byte[] payload = PodBinaryCodec.EncodeUploadAssetFacts(value);
        Assert.Equal(760, payload.Length);
        Assert.Equal(size, BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(544)));
        Assert.True(PodBinaryCodec.TryDecodeUploadAssetFacts(payload, out var decoded));
        Assert.Equal(value, decoded);
        byte[] frame = new AedsEncoder().Encode(AedsFrameType.UploadAssetFacts, payload);
        Assert.Equal(776, frame.Length);
        Assert.Equal(285, BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(8)));
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(payload, out _));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(20_971_521)]
    [InlineData(9_007_199_254_740_993)]
    public void InvalidAssetSize_RefusesEncodingAndIndependentHeader(long size)
    {
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeUploadAssetFacts(Fixture(size)));
        byte[] payload = PodBinaryCodec.EncodeUploadAssetFacts(Fixture(1));
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(544), size);
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetFacts(payload, out _));
    }

    [Fact]
    public void TrailingDataReservedFieldsAndPreviewSchema_RefuseFacts()
    {
        byte[] payload = PodBinaryCodec.EncodeUploadAssetFacts(Fixture(1));
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetFacts(payload.AsMemory(0, 759), out _));
        byte[] appended = [.. payload, 1];
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetFacts(appended, out _));
        payload[756] = 1;
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetFacts(payload, out _));
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeUploadAssetFacts(Fixture(1) with
        {
            Schema = UploadAssetPreviewDto.SchemaName
        }));
        Assert.Equal(FsusBlog.Server.Services.FileService.MaxUploadBytes, UploadAssetFactsDto.MaxAssetBytes);
    }

    private static UploadAssetFactsDto Fixture(long size)
        => new()
        {
            UploadId = "0123456789abcdef0123456789abcdef",
            AssetId = "01234567-89ab-cdef-0123-456789abcdef",
            PublicUrl = "/uploads/illustration/0123456789abcdef0123456789abcdef.png",
            MimeType = "image/png",
            Extension = ".png",
            SizeBytes = size,
            Sha256 = new string('a', 64),
            AssetVersionSha256 = new string('b', 64),
            ReferenceLedgerSha256 = new string('c', 64)
        };
}
