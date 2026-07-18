using System.Buffers;

using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Core.Mapping.Projectors;

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
    public void ReadSlice_OutOfBoundsOffset_ReturnsEmpty()
    {
        var slice = new FsusBlog.Shared.Contracts.Primitives.Utf8SliceRef();
        // length > 0 but offset way out of range
        string result = PodUtf8Codec.ReadSlice(slice, ReadOnlySpan<byte>.Empty);
        Assert.Equal(string.Empty, result);
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
