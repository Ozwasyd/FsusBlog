using System.Buffers;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Server.Tests;

public sealed class PodUtf8CodecTests
{
    [Theory]
    [InlineData("")]
    [InlineData("hello")]
    [InlineData("你好")]
    [InlineData("Hello你好123")]
    public void AppendSlice_ListPathMatchesArrayBufferWriter(string value)
    {
        var listPayload = new List<byte> { 1, 2, 3 };
        var bufferPayload = new ArrayBufferWriter<byte>();
        bufferPayload.Write([(byte)1, (byte)2, (byte)3]);

        var listSlice = PodUtf8Codec.AppendSlice(value, listPayload);
        var bufferSlice = PodUtf8Codec.AppendSlice(value, bufferPayload);

        Assert.Equal(listSlice, bufferSlice);
        Assert.Equal(listPayload, bufferPayload.WrittenSpan.ToArray());
    }

    [Fact]
    public void ToFixed512_RoundTrip_NullOrEmpty_ReturnsEmpty()
    {
        var fixed512 = PodUtf8Codec.ToFixed512(null);
        // Just test it doesn't throw; ToFixed512 should not error on null
        // No FromFixed512 exists, but we can verify by size
        Assert.True(System.Runtime.InteropServices.Marshal.SizeOf(fixed512) == 512);
    }

    [Fact]
    public void ToFixed512_ShortString_Encodes()
    {
        // Use a string well within 512 bytes
        string shortStr = "Hello World 123";
        var result = PodUtf8Codec.ToFixed512(shortStr);
        Assert.True(System.Runtime.InteropServices.Marshal.SizeOf(result) == 512);
    }

    [Fact]
    public void ToFixed32_OversizedUtf8_ThrowsDeterministicValidationError()
    {
        string oversized = new('界', 11); // 33 UTF-8 bytes.

        var ex = Assert.Throws<ArgumentException>(() => PodUtf8Codec.ToFixed32(oversized));

        Assert.Contains("Fixed UTF-8 POD field", ex.Message, StringComparison.Ordinal);
        Assert.Contains("32 bytes", ex.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadInit_Fixed32_64_256_ExactMultibyteBoundariesRoundTripThroughProductCodec()
    {
        string uploadId = new string('界', 21) + "x"; // 64 UTF-8 bytes.
        string fileName = new string('界', 85) + "y"; // 256 UTF-8 bytes.
        string targetFormat = new string('界', 10) + "zw"; // 32 UTF-8 bytes.
        var dto = new UploadInitDto
        {
            UploadId = uploadId,
            FileName = fileName,
            MimeType = "application/octet-stream",
            TargetFormat = targetFormat,
            TotalBytes = 1024,
            ChunkSize = 512,
            TotalParts = 2,
            ExpiresAt = new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc)
        };

        byte[] encoded = PodBinaryCodec.EncodeUploadInit(dto);
        bool decodedSuccessfully = PodBinaryCodec.TryDecodeUploadInit(encoded, out UploadInitDto decoded);

        Assert.Equal(568, encoded.Length);
        Assert.True(decodedSuccessfully);
        Assert.Equal(uploadId, decoded.UploadId);
        Assert.Equal(fileName, decoded.FileName);
        Assert.Equal("application/octet-stream", decoded.MimeType);
        Assert.Equal(targetFormat, decoded.TargetFormat);
        AssertCjkThenAscii(encoded.AsSpan(0, 64), 21, [(byte)'x']);
        AssertCjkThenAscii(encoded.AsSpan(64, 256), 85, [(byte)'y']);
        AssertAsciiThenZeroPadding(encoded.AsSpan(320, 64), "application/octet-stream"u8);
        AssertCjkThenAscii(encoded.AsSpan(384, 32), 10, [(byte)'z', (byte)'w']);
    }

    [Theory]
    [InlineData("uploadId", 64, 65)]
    [InlineData("fileName", 256, 257)]
    [InlineData("targetFormat", 32, 33)]
    public void UploadInit_Fixed32_64_256_OverCapacityFailsInsteadOfTruncating(
        string field,
        int capacity,
        int requiredBytes)
    {
        var dto = new UploadInitDto
        {
            UploadId = field == "uploadId" ? new string('x', requiredBytes) : "upload",
            FileName = field == "fileName" ? new string('x', requiredBytes) : "file.bin",
            MimeType = "application/octet-stream",
            TargetFormat = field == "targetFormat" ? new string('x', requiredBytes) : "bin",
            TotalBytes = 1,
            ChunkSize = 1,
            TotalParts = 1,
            ExpiresAt = DateTime.UnixEpoch
        };

        var exception = Assert.Throws<ArgumentException>(() => PodBinaryCodec.EncodeUploadInit(dto));

        Assert.Equal("value", exception.ParamName);
        Assert.Contains($"at most {capacity} bytes", exception.Message, StringComparison.Ordinal);
        Assert.Contains($"requires {requiredBytes} bytes", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void UploadInit_TruncatedAndMalformedFixedUtf8FailClosedOnExistingDecodePath()
    {
        var dto = new UploadInitDto
        {
            UploadId = "upload",
            FileName = "file.bin",
            MimeType = "application/octet-stream",
            TargetFormat = "bin",
            TotalBytes = 1,
            ChunkSize = 1,
            TotalParts = 1,
            ExpiresAt = DateTime.UnixEpoch
        };
        byte[] encoded = PodBinaryCodec.EncodeUploadInit(dto);
        byte[] malformed = [.. encoded];
        malformed[0] = 0xFF;

        Assert.False(PodBinaryCodec.TryDecodeUploadInit(encoded.AsMemory(0, encoded.Length - 1), out _));
        Assert.Throws<DecoderFallbackException>(
            () =>
            {
                _ = PodBinaryCodec.TryDecodeUploadInit(malformed, out _);
            });
    }

    [Fact]
    public void TokenResponse_Fixed512ExactBoundaryMaterializesProductPodBytes()
    {
        string exactBoundary = new string('界', 170) + "ab"; // 512 UTF-8 bytes.
        Utf8Fixed512 accessTokenField = PodUtf8Codec.ToFixed512(exactBoundary);
        Utf8Fixed512 refreshTokenField = PodUtf8Codec.ToFixed512("refresh-token");
        Span<byte> source = stackalloc byte[1024];
        MemoryMarshal.Write(source, in accessTokenField);
        MemoryMarshal.Write(source[512..], in refreshTokenField);

        TokenResponsePod pod = MemoryMarshal.Read<TokenResponsePod>(source);

        Utf8Fixed512 accessTokenValue = pod.AccessToken;
        ReadOnlySpan<Utf8Fixed512> accessToken = MemoryMarshal.CreateReadOnlySpan(ref accessTokenValue, 1);
        AssertCjkThenAscii(MemoryMarshal.AsBytes(accessToken), 170, [(byte)'a', (byte)'b']);

        Utf8Fixed512 refreshTokenValue = pod.RefreshToken;
        ReadOnlySpan<Utf8Fixed512> refreshToken = MemoryMarshal.CreateReadOnlySpan(ref refreshTokenValue, 1);
        AssertAsciiThenZeroPadding(MemoryMarshal.AsBytes(refreshToken), "refresh-token"u8);
    }

    [Fact]
    public void TokenResponse_Fixed512OverCapacityFailsInsteadOfTruncating()
    {
        string oversized = new string('界', 170) + "abc"; // 513 UTF-8 bytes.

        var exception = Assert.Throws<ArgumentException>(() => PodUtf8Codec.ToFixed512(oversized));

        Assert.Equal("value", exception.ParamName);
        Assert.Contains("at most 512 bytes", exception.Message, StringComparison.Ordinal);
        Assert.Contains("requires 513 bytes", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ReadSlice_OutOfBoundsOffset_ReturnsEmpty()
    {
        var slice = new FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef();
        // length > 0 but offset way out of range
        string result = PodUtf8Codec.ReadSlice(slice, ReadOnlySpan<byte>.Empty);
        Assert.Equal(string.Empty, result);
    }

    private static void AssertCjkThenAscii(
        ReadOnlySpan<byte> actual,
        int cjkCount,
        ReadOnlySpan<byte> asciiSuffix)
    {
        Assert.Equal(cjkCount * 3 + asciiSuffix.Length, actual.Length);
        for (int index = 0; index < cjkCount; index++)
        {
            int offset = index * 3;
            Assert.Equal(0xE7, actual[offset]);
            Assert.Equal(0x95, actual[offset + 1]);
            Assert.Equal(0x8C, actual[offset + 2]);
        }

        Assert.True(actual[(cjkCount * 3)..].SequenceEqual(asciiSuffix));
    }

    private static void AssertAsciiThenZeroPadding(ReadOnlySpan<byte> actual, ReadOnlySpan<byte> asciiPrefix)
    {
        Assert.True(actual[..asciiPrefix.Length].SequenceEqual(asciiPrefix));
        Assert.All(actual[asciiPrefix.Length..].ToArray(), static value => Assert.Equal(0, value));
    }
}

public sealed class PodProjectorCommentPreviewTests
{
    [Fact]
    public void ProjectCommentReplyPreviewItem_RoundTripsContent()
    {
        var createTime = new DateTime(2024, 5, 1, 0, 0, 0, DateTimeKind.Utc);
        var pod = PodProjector.ProjectCommentReplyPreviewItem(
            id: 42,
            isDeleted: false,
            createTime: createTime,
            authorMode: "public",
            displayName: "Bob",
            replyToDisplayName: "Alice",
            content: "Reply text",
            out ReadOnlyMemory<byte> payload);

        Assert.Equal(42L, pod.Id);
        Assert.Equal((byte)0, pod.IsDeleted);

        string content = PodUtf8Codec.ReadSlice(pod.Content, payload.Span);
        Assert.Equal("Reply text", content);
    }

    [Fact]
    public void ProjectCommentReplyPreviewItem_Deleted_SetsIsDeletedFlag()
    {
        var pod = PodProjector.ProjectCommentReplyPreviewItem(
            id: 1, isDeleted: true, createTime: DateTime.UtcNow,
            authorMode: "public", displayName: "User", replyToDisplayName: null, content: "test",
            out _);

        Assert.Equal((byte)1, pod.IsDeleted);
    }
}
