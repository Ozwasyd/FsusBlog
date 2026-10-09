using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Tests.Unit;

// Managed component buffers only: these tests do not establish native admission or lifetime qualification.
public sealed class ReservedAedsFrameWriterTests
{
    [Fact]
    public void GetMemoryAndSpan_RejectNegativeSizeHint()
    {
        var writer = new ReservedAedsFrameWriter(new byte[4]);

        Assert.Throws<ArgumentOutOfRangeException>(() => writer.GetMemory(-1));
        Assert.Throws<ArgumentOutOfRangeException>(() => writer.GetSpan(-1));
        Assert.Equal(0, writer.WrittenCount);
    }

    [Fact]
    public void Advance_RejectsNegativeAndOverRemainingCount()
    {
        var writer = new ReservedAedsFrameWriter(new byte[4]);
        writer.Advance(2);

        Assert.Throws<ArgumentOutOfRangeException>(() => writer.Advance(-1));
        Assert.Throws<ArgumentOutOfRangeException>(() => writer.Advance(3));
        Assert.Throws<ArgumentOutOfRangeException>(() => writer.Advance(int.MaxValue));
        Assert.Equal(2, writer.WrittenCount);
    }

    [Fact]
    public void GetMemoryAndSpan_RejectHintsBeyondRemainingCapacity()
    {
        var writer = new ReservedAedsFrameWriter(new byte[4]);
        writer.Advance(3);

        Assert.Throws<ArgumentException>(() => writer.GetMemory(2));
        Assert.Throws<ArgumentException>(() => writer.GetSpan(int.MaxValue));
        Assert.Equal(1, writer.GetMemory().Length);
        Assert.Equal(1, writer.GetSpan().Length);
    }

    [Fact]
    public void GetMemoryAndSpan_RejectEmptyAndExhaustedDestinations()
    {
        var empty = new ReservedAedsFrameWriter(Memory<byte>.Empty);
        var writer = new ReservedAedsFrameWriter(new byte[1]);
        writer.Advance(1);
        writer.Advance(0);

        Assert.Throws<ArgumentException>(() => empty.GetMemory());
        Assert.Throws<ArgumentException>(() => empty.GetSpan());
        Assert.Throws<ArgumentException>(() => writer.GetMemory());
        Assert.Throws<ArgumentException>(() => writer.GetSpan(1));
        Assert.Equal(1, writer.WrittenCount);
    }

    [Fact]
    public void Writer_UsesOnlyCallerSliceAndAdvancesWriteBoundary()
    {
        byte[] storage = [90, 90, 90, 90, 90, 90];
        var writer = new ReservedAedsFrameWriter(storage.AsMemory(1, 4));
        writer.GetSpan(2)[..2].Fill(1);
        writer.Advance(2);
        writer.GetMemory(2).Span.Fill(2);
        writer.Advance(2);

        Assert.Equal(new byte[] { 90, 1, 1, 2, 2, 90 }, storage);
        Assert.Equal(4, writer.WrittenMemory.Length);
        Assert.True(writer.WrittenMemory.Span.SequenceEqual(storage.AsSpan(1, 4)));
    }

    [Fact]
    public void GetFrameLength_RejectsNegativeAndCheckedOverflow()
    {
        var options = new PublicHotReadOptions { MaxFrameBytes = int.MaxValue };

        Assert.Throws<ArgumentOutOfRangeException>(() => ReservedAedsFrameWriter.GetFrameLength(-1, options));
        Assert.Throws<OverflowException>(() => ReservedAedsFrameWriter.GetFrameLength(int.MaxValue, options));
        Assert.Equal(int.MaxValue, ReservedAedsFrameWriter.GetFrameLength(int.MaxValue - AedsFrameHeader.Size, options));
    }

    [Fact]
    public void GetFrameLength_EnforcesConfiguredAndDefaultArtifactCeiling()
    {
        var options = new PublicHotReadOptions();
        int maximumPayload = options.MaxFrameBytes - AedsFrameHeader.Size;

        Assert.Equal(options.MaxFrameBytes, ReservedAedsFrameWriter.GetFrameLength(maximumPayload, options));
        Assert.Throws<InvalidOperationException>(() => ReservedAedsFrameWriter.GetFrameLength(maximumPayload + 1, options));
        options.MaxFrameBytes = AedsFrameHeader.Size;
        Assert.Equal(AedsFrameHeader.Size, ReservedAedsFrameWriter.GetFrameLength(0, options));
        Assert.Throws<InvalidOperationException>(() => ReservedAedsFrameWriter.GetFrameLength(1, options));
    }

    [Fact]
    public void WriteFrame_RejectsInsufficientStorageAndArtifactCeilingBeforeWriting()
    {
        var encoder = new AedsEncoder();
        byte[] storage = new byte[AedsFrameHeader.Size];
        storage.AsSpan().Fill(90);
        var options = new PublicHotReadOptions();

        Assert.Throws<ArgumentException>(() => ReservedAedsFrameWriter.WriteFrame(encoder, AedsFrameType.ArticleList, new byte[1], storage, options));
        options.MaxFrameBytes = AedsFrameHeader.Size - 1;
        Assert.Throws<InvalidOperationException>(() => ReservedAedsFrameWriter.WriteFrame(encoder, AedsFrameType.ArticleList, [], storage, options));
        Assert.All(storage, value => Assert.Equal((byte)90, value));
    }

    [Fact]
    public void WriteFrame_MatchesCanonicalEncodeAndPreservesOutsideBytes()
    {
        var encoder = new AedsEncoder();
        byte[] payload = [1, 2, 0, 255, 128];
        byte[] reference = encoder.Encode(AedsFrameType.ArticleDetail, payload, flags: 0xDEAD);
        byte[] storage = new byte[reference.Length + 4];
        storage.AsSpan().Fill(90);
        var options = new PublicHotReadOptions { MaxFrameBytes = reference.Length };

        ReadOnlyMemory<byte> frame = ReservedAedsFrameWriter.WriteFrame(
            encoder, AedsFrameType.ArticleDetail, payload, storage.AsMemory(1, reference.Length + 2), options, flags: 0xDEAD);

        Assert.True(frame.Span.SequenceEqual(reference));
        Assert.Equal(reference.Length, frame.Length);
        Assert.Equal((byte)90, storage[0]);
        for (int index = reference.Length + 1; index < storage.Length; index++)
        {
            Assert.Equal((byte)90, storage[index]);
        }
        storage[1] = 7;
        Assert.Equal((byte)7, frame.Span[0]);
    }

    [Fact]
    public void WriteFrame_EmptyPayloadMatchesCanonicalEncodeAtExactCapacity()
    {
        var encoder = new AedsEncoder();
        byte[] storage = new byte[AedsFrameHeader.Size];
        var options = new PublicHotReadOptions { MaxFrameBytes = storage.Length };

        ReadOnlyMemory<byte> frame = ReservedAedsFrameWriter.WriteFrame(encoder, AedsFrameType.ArticleList, [], storage, options);

        Assert.True(frame.Span.SequenceEqual(encoder.Encode(AedsFrameType.ArticleList, [])));
    }
}
