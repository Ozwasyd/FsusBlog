using System.Buffers.Binary;
using System.Runtime.InteropServices;

using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests;

// Ordinary payload controls only; no allocated frame, runtime or upload-session acceptance.
public sealed class UploadAssetFactsPayloadSourceTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(8_387_832)]
    [InlineData(8_387_833)]
    [InlineData(20_971_520)]
    public void FactsUseFixedOriginalPodAndUploadBoundWithoutImageBytes(long size)
    {
        byte[] payload = PodBinaryCodec.EncodeUploadAssetFacts(Fixture(size));
        Assert.Equal(760, Marshal.SizeOf<UploadAssetPreviewPod>());
        Assert.Equal(760, payload.Length);
        Assert.Equal(544, Marshal.OffsetOf<UploadAssetPreviewPod>(nameof(UploadAssetPreviewPod.SizeBytes)).ToInt32());
        Assert.Equal(size, BinaryPrimitives.ReadInt64LittleEndian(payload.AsSpan(544)));
        Assert.True(PodBinaryCodec.TryDecodeUploadAssetFacts(payload, out var decoded));
        Assert.Equal(Fixture(size), decoded);
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetPreview(payload, out _));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(20_971_521)]
    [InlineData(9_007_199_254_740_993)]
    public void InvalidSizeCannotEnterFactsPayload(long size)
    {
        Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeUploadAssetFacts(Fixture(size)));
        byte[] payload = PodBinaryCodec.EncodeUploadAssetFacts(Fixture(1));
        BinaryPrimitives.WriteInt64LittleEndian(payload.AsSpan(544), size);
        Assert.False(PodBinaryCodec.TryDecodeUploadAssetFacts(payload, out _));
    }

    [Fact]
    public void TruncatedTrailingReservedAndPreviewSchemaRefuse()
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
    }

    private static UploadAssetFactsDto Fixture(long size) => new()
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
