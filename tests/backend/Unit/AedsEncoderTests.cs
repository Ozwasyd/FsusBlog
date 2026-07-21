using System.Buffers;
using System.Buffers.Binary;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Results;

using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Unit tests for AedsEncoder — encode, decode, round-trip, and error paths.
/// Pure algorithm, no external dependencies.
/// </summary>
public sealed class AedsEncoderTests
{
    private readonly AedsEncoder _enc = new();

    // ─── Encode / header magic ────────────────────────────────────────────

    [Fact]
    public void Encode_FrameStartsWithAedsMagic()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(0, 4));
        Assert.Equal(AedsEncoder.Magic, magic);
    }

    [Fact]
    public void Encode_FrameLengthEqualsHeaderPlusPayload()
    {
        byte[] payload = new byte[32];
        byte[] frame = _enc.Encode(AedsFrameType.ArticleDetail, payload);
        Assert.Equal(AedsFrameHeader.Size + 32, frame.Length);
    }

    [Fact]
    public void Encode_WritesCorrectFrameType()
    {
        byte[] frame = _enc.Encode(AedsFrameType.AdminStats, []);
        ushort frameTypeRaw = BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(8, 2));
        Assert.Equal((ushort)AedsFrameType.AdminStats, frameTypeRaw);
    }

    [Fact]
    public void Encode_WritesCorrectVersion()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        Assert.Equal(AedsFrameHeader.CurrentVersion, frame[4]);
        Assert.Equal(AedsFrameHeader.Size, frame[5]);
    }

    [Fact]
    public void Encode_WritesCorrectFlags()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, [], flags: 0xDEAD);
        ushort flags = BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(6, 2));
        Assert.Equal(0xDEAD, flags);
    }

    [Fact]
    public void Encode_WritesCorrectPayloadLength()
    {
        byte[] payload = new byte[100];
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, payload);
        uint payloadLen = BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(10, 4));
        Assert.Equal(100u, payloadLen);
    }

    [Fact]
    public void Encode_WritesModbusCrc16KnownVector()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, "123456789"u8);
        ushort payloadCrc = BinaryPrimitives.ReadUInt16LittleEndian(frame.AsSpan(14, 2));
        Assert.Equal(0x4B37, payloadCrc);
    }

    [Fact]
    public void AedsCrc16_KnownVector_MatchesModbus()
    {
        Assert.Equal(0x4B37, AedsCrc16.Compute("123456789"u8));
    }

    [Fact]
    public void Encode_EmptyPayloadProducesMinimalFrame()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ApiError, []);
        Assert.Equal(AedsFrameHeader.Size, frame.Length);
    }

    // ─── TryDecode — happy path ───────────────────────────────────────────

    [Fact]
    public void TryDecode_SucceedsForValidFrame()
    {
        byte[] payload = "hello world"u8.ToArray();
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, payload);

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.True(result.IsSuccess);
        Assert.Equal(AedsFrameType.ArticleList, result.Value.FrameType);
    }

    [Fact]
    public void TryDecode_PreservesPayloadContentExactly()
    {
        byte[] payload = [1, 2, 3, 4, 5, 255, 0, 128];
        byte[] frame = _enc.Encode(AedsFrameType.ArticleDetail, payload);

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.True(result.IsSuccess);
        Assert.True(result.Value.Payload.Span.SequenceEqual(payload));
    }

    [Fact]
    public void TryDecode_SucceedsForEmptyPayload()
    {
        byte[] frame = _enc.Encode(AedsFrameType.AdminStats, []);

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.True(result.IsSuccess);
        Assert.Equal(0, result.Value.Payload.Length);
    }

    // ─── TryDecode — error paths ──────────────────────────────────────────

    [Fact]
    public void TryDecode_FailsForTooShortFrame()
    {
        Result<AedsDecodeResult> result = _enc.TryDecode(new byte[4]);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS frame too short", result.Error.Message);
    }

    [Fact]
    public void TryDecode_FailsForEmptyInput()
    {
        Result<AedsDecodeResult> result = _enc.TryDecode(ReadOnlyMemory<byte>.Empty);

        Assert.False(result.IsSuccess);
    }

    [Fact]
    public void TryDecode_FailsForBadMagic()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        // corrupt magic
        frame[0] = 0xFF;

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.False(result.IsSuccess);
        Assert.Contains("magic", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryDecode_FailsForUnsupportedVersion()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        frame[4] = 1;

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.False(result.IsSuccess);
        Assert.Contains("version", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryDecode_FailsForBadHeaderLength()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        frame[5] = 24;

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.False(result.IsSuccess);
        Assert.Contains("header length", result.Error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void TryDecode_FailsForCorruptedPayload()
    {
        byte[] payload = new byte[16];
        Array.Fill(payload, (byte)0xAB);
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, payload);
        // Corrupt a payload byte
        frame[AedsFrameHeader.Size] ^= 0xFF;

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS payload crc mismatch", result.Error.Message);
    }

    [Fact]
    public void TryDecode_FailsForUnknownFrameType()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        // Overwrite frame type with undefined value (0xFFFF)
        // Must also fix CRC (easiest: build a new frame with bad type manually)
        // We use a simpler approach: encode with valid type, then corrupt frameType bytes and re-CRC
        // Instead just write the raw bytes directly
        var writer = new ArrayBufferWriter<byte>();
        Span<byte> buf = writer.GetSpan(AedsFrameHeader.Size);
        frame.AsSpan(0, AedsFrameHeader.Size).CopyTo(buf);
        // Set frameType to 0x7FFF (not in enum)
        BinaryPrimitives.WriteUInt16LittleEndian(buf[8..10], 0x7FFF);
        // The CRC won't match so we'll get a CRC error first — but that also means decode fails
        writer.Advance(AedsFrameHeader.Size);

        Result<AedsDecodeResult> result = _enc.TryDecode(writer.WrittenMemory);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS frame type unsupported", result.Error.Message);
    }

    [Theory]
    [InlineData(40)]
    [InlineData(43)]
    [InlineData(44)]
    [InlineData(45)]
    [InlineData(46)]
    public void TryDecode_RejectsEveryRetiredFrameType(int frameTypeRaw)
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, []);
        BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8, 2), checked((ushort)frameTypeRaw));

        Result<AedsDecodeResult> result = _enc.TryDecode(frame);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS frame type retired", result.Error.Message);
    }

    [Fact]
    public void TryDecode_FailsWhenPayloadLengthIsWrong()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleList, [1, 2, 3]);
        // Trim one byte from the end to misalign the payload length
        byte[] trimmed = frame[..^1];

        Result<AedsDecodeResult> result = _enc.TryDecode(trimmed);

        Assert.False(result.IsSuccess);
        Assert.Equal("AEDS payload length mismatch", result.Error.Message);
    }

    [Fact]
    public void WriteHeader_AcceptsAndPersistsMaximumV2Flags()
    {
        byte[] payload = [1, 2, 3, 4];
        var writer = new ArrayBufferWriter<byte>();

        _enc.WriteHeader(AedsFrameType.ArticleDetail, payload, writer, flags: ushort.MaxValue);

        Assert.Equal(AedsFrameHeader.Size, writer.WrittenCount);
        ReadOnlySpan<byte> header = writer.WrittenSpan;
        Assert.Equal(AedsEncoder.Magic, BinaryPrimitives.ReadUInt32LittleEndian(header[0..4]));
        Assert.Equal(ushort.MaxValue, BinaryPrimitives.ReadUInt16LittleEndian(header[6..8]));
        Assert.Equal((ushort)AedsFrameType.ArticleDetail, BinaryPrimitives.ReadUInt16LittleEndian(header[8..10]));
        Assert.Equal((uint)payload.Length, BinaryPrimitives.ReadUInt32LittleEndian(header[10..14]));
        Assert.Equal(AedsCrc16.Compute(payload), BinaryPrimitives.ReadUInt16LittleEndian(header[14..16]));
    }

    [Fact]
    public void Encode_RejectsUnsupportedVersionWithExactReason()
    {
        ArgumentOutOfRangeException error = Assert.Throws<ArgumentOutOfRangeException>(
            () => _enc.Encode(AedsFrameType.ArticleList, [], version: 1));

        Assert.Equal("version", error.ParamName);
        Assert.StartsWith("AEDS v2 is the only supported wire version.", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Encode_RejectsFlagsLargerThanUInt16WithExactReason()
    {
        ArgumentOutOfRangeException error = Assert.Throws<ArgumentOutOfRangeException>(
            () => _enc.Encode(AedsFrameType.ArticleList, [], flags: (uint)ushort.MaxValue + 1));

        Assert.Equal("flags", error.ParamName);
        Assert.StartsWith("AEDS v2 flags are uint16.", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TryDecode_FuzzMalformedFramesNeverThrowsOrSucceeds()
    {
        var random = new Random(0xAED5);
        List<byte[]> malformedFrames = [];

        for (int i = 0; i < 128; i++)
        {
            byte[] fuzz = new byte[random.Next(0, 256)];
            random.NextBytes(fuzz);
            malformedFrames.Add(fuzz);
        }

        byte[] valid = _enc.Encode(AedsFrameType.ArticleList, [1, 2, 3, 4, 5]);
        malformedFrames.Add(Mutate(valid, frame => frame[4] = 0xFF)); // unknown version
        malformedFrames.Add(Mutate(valid, frame => frame[5] = 0xFF)); // invalid header length
        malformedFrames.Add(Mutate(valid, frame => BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(10, 4), 1024 * 1024))); // oversized declared payload
        malformedFrames.Add(Mutate(valid, frame => BinaryPrimitives.WriteUInt16LittleEndian(frame.AsSpan(8, 2), 0x7FFF))); // unknown frame type
        malformedFrames.Add(Mutate(valid, frame => frame[^1] ^= 0x7F)); // CRC mismatch
        malformedFrames.Add(valid[..^1]); // truncated payload

        byte[] nestedMalformed = _enc.Encode(AedsFrameType.ArticleDetail, valid[..8]);
        malformedFrames.Add(Mutate(nestedMalformed, frame => BinaryPrimitives.WriteUInt32LittleEndian(frame.AsSpan(10, 4), 999_999)));

        foreach (byte[] frame in malformedFrames)
        {
            Result<AedsDecodeResult> result = _enc.TryDecode(frame);
            Assert.False(result.IsSuccess);
        }
    }

    private static byte[] Mutate(byte[] frame, Action<byte[]> mutation)
    {
        byte[] copy = [.. frame];
        mutation(copy);
        return copy;
    }

    // ─── WriteFrame (IBufferWriter) ───────────────────────────────────────

    [Fact]
    public void WriteFrame_ProducesSameResultAsEncode()
    {
        byte[] payload = [10, 20, 30];
        byte[] encoded = _enc.Encode(AedsFrameType.CommentArticleCursor, payload);

        var writer = new ArrayBufferWriter<byte>();
        _enc.WriteFrame(AedsFrameType.CommentArticleCursor, payload, writer);

        Assert.Equal(encoded, writer.WrittenMemory.ToArray());
    }

    [Fact]
    public void FrameBufferWriter_SealsSameFrameAsEncode()
    {
        byte[] payload = [10, 20, 30, 40, 50];
        byte[] encoded = _enc.Encode(AedsFrameType.ArticleDetail, payload);

        using var writer = new AedsFrameBufferWriter(32);
        writer.Write(payload);
        writer.Seal(AedsFrameType.ArticleDetail);

        Assert.Equal(payload.Length, writer.PayloadLength);
        Assert.Equal(encoded, writer.WrittenFrame.ToArray());
    }

    [Fact]
    public void FrameBufferWriter_ReservesHeaderBeforePayload()
    {
        byte[] payload = [1, 2, 3];

        using var writer = new AedsFrameBufferWriter(17);
        writer.PayloadWriter.GetSpan(payload.Length)[..payload.Length].Fill(0xFE);
        writer.PayloadWriter.Write(payload);
        writer.Seal(AedsFrameType.MutationId);

        byte[] frame = writer.WrittenFrame.ToArray();
        Assert.Equal(payload, frame.AsSpan(AedsFrameHeader.Size).ToArray());
        Assert.Equal((uint)payload.Length, BinaryPrimitives.ReadUInt32LittleEndian(frame.AsSpan(10, 4)));
    }

    [Fact]
    public void FrameBufferWriter_RejectsWritesAfterSeal()
    {
        using var writer = new AedsFrameBufferWriter();
        writer.Write([1, 2, 3]);
        writer.Seal(AedsFrameType.EmptySuccess);

        Assert.Throws<InvalidOperationException>(() => writer.Write([4]));
    }

    [Theory]
    [InlineData(AedsFrameType.Unknown)]
    [InlineData(AedsFrameType.AdminStats)]
    [InlineData(AedsFrameType.AuthLoginFlow)]
    [InlineData(AedsFrameType.CurrentUserSnapshot)]
    [InlineData(AedsFrameType.MfaChallengeResult)]
    [InlineData(AedsFrameType.PasskeyLoginBegin)]
    [InlineData(AedsFrameType.Reserved178)]
    [InlineData(AedsFrameType.ApiError)]
    public void FrameBufferWriter_SensitiveAndUnknownFramesAlwaysClearPoolBuffer(AedsFrameType frameType)
    {
        var pool = new TrackingArrayPool();
        using (var writer = new AedsFrameBufferWriter(64, pool))
        {
            writer.Write([1, 2, 3]);
            writer.Seal(frameType);
        }

        Assert.Single(pool.Returns);
        Assert.True(pool.Returns[0].ClearArray);
        Assert.True(AedsFrameSensitivity.RequiresClear(frameType));
    }

    [Theory]
    [InlineData(AedsFrameType.ArticleList)]
    [InlineData(AedsFrameType.ArticleDetail)]
    [InlineData(AedsFrameType.ArticleHot)]
    [InlineData(AedsFrameType.CategoryList)]
    [InlineData(AedsFrameType.TagList)]
    [InlineData(AedsFrameType.PublicAotBootstrap)]
    public void FrameBufferWriter_PublicImmutableWhitelistMaySkipFinalPoolClear(AedsFrameType frameType)
    {
        var pool = new TrackingArrayPool();
        using (var writer = new AedsFrameBufferWriter(64, pool))
        {
            writer.Write([1, 2, 3]);
            writer.Seal(frameType);
        }

        Assert.Single(pool.Returns);
        Assert.False(pool.Returns[0].ClearArray);
        Assert.True(AedsFrameSensitivity.IsPublicImmutable(frameType));
    }

    [Fact]
    public async Task PreencodedFrameResult_AppliesMetadataAndHonorsIfNoneMatch()
    {
        byte[] frame = _enc.Encode(AedsFrameType.ArticleDetail, [1, 2, 3]);
        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();
        context.Request.Headers.IfNoneMatch = "\"frame-etag\"";

        var result = new BinaryPreencodedFrameResult(
            frame,
            metadata: new BinaryFrameResponseMetadata(
                ETag: "\"frame-etag\"",
                CacheControl: "public,max-age=60",
                ContentEncoding: "br",
                VaryAcceptEncoding: true));

        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status304NotModified, context.Response.StatusCode);
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Equal("\"frame-etag\"", context.Response.Headers.ETag);
        Assert.Equal("public,max-age=60", context.Response.Headers.CacheControl);
        Assert.Equal("br", context.Response.Headers.ContentEncoding);
        Assert.Equal("Accept-Encoding", context.Response.Headers.Vary);
        Assert.Equal("none", context.Response.Headers.AcceptRanges);
        Assert.Empty(((MemoryStream)context.Response.Body).ToArray());
    }

    // ─── Round-trip via AedsDecoderValidator ─────────────────────────────

    [Theory]
    [InlineData(AedsFrameType.ArticleList)]
    [InlineData(AedsFrameType.ArticleDetail)]
    [InlineData(AedsFrameType.CommentArticleCursor)]
    [InlineData(AedsFrameType.AdminStats)]
    [InlineData(AedsFrameType.ApiError)]
    public void ValidateRoundTrip_SucceedsForAllFrameTypes(AedsFrameType frameType)
    {
        var validator = new AedsDecoderValidator(_enc);
        byte[] payload = [0x01, 0x02, 0x03];

        Result result = validator.ValidateRoundTrip(frameType, payload);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void ValidateRoundTrip_SucceedsForEmptyPayload()
    {
        var validator = new AedsDecoderValidator(_enc);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, []);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void ValidateRoundTrip_SucceedsForLargePayload()
    {
        var validator = new AedsDecoderValidator(_enc);
        byte[] payload = new byte[4096];
        for (int i = 0; i < payload.Length; i++)
            payload[i] = (byte)(i & 0xFF);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleDetail, payload);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void ValidateRoundTrip_RespectsVersionField()
    {
        var validator = new AedsDecoderValidator(_enc);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [42], version: 2);

        Assert.True(result.IsSuccess);
    }

    [Fact]
    public void ValidateRoundTrip_RespectsFlags()
    {
        var validator = new AedsDecoderValidator(_enc);

        Result result = validator.ValidateRoundTrip(AedsFrameType.ArticleList, [42], flags: 0xCAFE);

        Assert.True(result.IsSuccess);
    }

    private sealed class TrackingArrayPool : ArrayPool<byte>
    {
        public List<(byte[] Buffer, bool ClearArray)> Returns { get; } = [];

        public override byte[] Rent(int minimumLength) => new byte[minimumLength];

        public override void Return(byte[] array, bool clearArray = false)
        {
            Returns.Add((array, clearArray));
            if (clearArray)
            {
                Array.Clear(array);
            }
        }
    }
}
