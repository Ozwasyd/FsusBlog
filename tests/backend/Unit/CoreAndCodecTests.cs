using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Governance;

namespace FsusBlog.Server.Tests.Unit;

public class PooledByteBufferWriterTests
{
    [Fact]
    public void InitialState_WrittenCountIsZero()
    {
        using var w = new PooledByteBufferWriter();
        Assert.Equal(0, w.WrittenCount);
    }

    [Fact]
    public void Write_ThenToArray_ReturnsExactBytes()
    {
        using var w = new PooledByteBufferWriter(16);
        byte[] src = [1, 2, 3, 4, 5];
        w.Write(src);

        Assert.Equal(5, w.WrittenCount);
        Assert.Equal(src, w.ToArray());
    }

    [Fact]
    public void Write_WrittenSpan_IsCorrect()
    {
        using var w = new PooledByteBufferWriter();
        w.Write([10, 20]);
        Assert.True(w.WrittenSpan.SequenceEqual(new byte[] { 10, 20 }));
    }

    [Fact]
    public void Write_WrittenMemory_IsCorrect()
    {
        using var w = new PooledByteBufferWriter();
        w.Write([7, 8, 9]);
        Assert.Equal(new byte[] { 7, 8, 9 }, w.WrittenMemory.ToArray());
    }

    [Fact]
    public void GetSpan_AdvanceWritesData()
    {
        using var w = new PooledByteBufferWriter();
        Span<byte> span = w.GetSpan(3);
        span[0] = 0xAA;
        span[1] = 0xBB;
        span[2] = 0xCC;
        w.Advance(3);

        Assert.Equal(new byte[] { 0xAA, 0xBB, 0xCC }, w.ToArray());
    }

    [Fact]
    public void GetMemory_AdvanceWritesData()
    {
        using var w = new PooledByteBufferWriter();
        Memory<byte> mem = w.GetMemory(2);
        mem.Span[0] = 0x01;
        mem.Span[1] = 0x02;
        w.Advance(2);

        Assert.Equal(new byte[] { 0x01, 0x02 }, w.ToArray());
    }

    [Fact]
    public void Advance_NegativeCount_Throws()
    {
        using var w = new PooledByteBufferWriter();
        Assert.Throws<ArgumentOutOfRangeException>(() => w.Advance(-1));
    }

    [Fact]
    public void Write_LargeData_TriggersGrowth()
    {
        // Write more than initial capacity to trigger buffer growth
        using var w = new PooledByteBufferWriter(16);
        byte[] large = new byte[1024];
        for (int i = 0; i < 1024; i++)
            large[i] = (byte)(i & 0xFF);
        w.Write(large);

        Assert.Equal(1024, w.WrittenCount);
        Assert.Equal(large, w.ToArray());
    }

    [Fact]
    public void DetachBuffer_ReturnsBufferAndInvalidatesWriter()
    {
        using var w = new PooledByteBufferWriter();
        w.Write([1, 2, 3]);
        byte[] buf = w.DetachBuffer(out int len);

        Assert.Equal(3, len);
        Assert.Equal(1, buf[0]);
        Assert.Throws<InvalidOperationException>(() => w.GetSpan(1));
        Assert.Throws<InvalidOperationException>(() => w.GetMemory(1));
        Assert.Throws<InvalidOperationException>(() => w.Advance(0));
        Assert.Throws<InvalidOperationException>(() => w.ToArray());
        Assert.Throws<InvalidOperationException>(() =>
        {
            _ = w.WrittenCount;
        });
    }

    [Fact]
    public void Dispose_CanBeCalledTwice()
    {
        Exception? error = Record.Exception(() =>
        {
            var w = new PooledByteBufferWriter();
            w.Dispose();
            w.Dispose();
        });

        Assert.Null(error);
    }

    [Fact]
    public void Dispose_InvalidatesWriter()
    {
        var w = new PooledByteBufferWriter();
        w.Write([1, 2, 3]);
        w.Dispose();

        Assert.Throws<ObjectDisposedException>(() => w.GetSpan(1));
        Assert.Throws<ObjectDisposedException>(() => w.GetMemory(1));
        Assert.Throws<ObjectDisposedException>(() => w.Advance(0));
        Assert.Throws<ObjectDisposedException>(() => w.ToArray());
        Assert.Throws<ObjectDisposedException>(() =>
        {
            _ = w.WrittenCount;
        });
    }
}

public class SearchIndexDeltaCodecTests
{
    [Fact]
    public void CreatePatch_EmptyTombstonesAndEmptyAppended_ReturnsHeaderBytes()
    {
        byte[] patch = SearchIndexDeltaCodec.CreatePatch([], []);
        // Header is 24 bytes minimum
        Assert.True(patch.Length >= 24);
    }

    [Fact]
    public void CreatePatch_WithTombstones_IsLargerThanHeader()
    {
        byte[] patch = SearchIndexDeltaCodec.CreatePatch([1u, 2u, 3u], []);
        Assert.True(patch.Length > 24);
    }

    [Fact]
    public void CreatePatch_WithAppended_IsLargerThanHeader()
    {
        byte[] appended = [0xAA, 0xBB, 0xCC, 0xDD];
        byte[] patch = SearchIndexDeltaCodec.CreatePatch([], appended);
        Assert.True(patch.Length > 24);
    }

    [Fact]
    public void CreatePatch_TombstonesAndAppended_CombinesBoth()
    {
        byte[] appended = new byte[100];
        byte[] patch = SearchIndexDeltaCodec.CreatePatch([10u, 20u, 30u], appended);
        Assert.True(patch.Length > 24 + appended.Length);
    }

    [Fact]
    public void CreatePatch_StartsWithMagicBytes()
    {
        byte[] patch = SearchIndexDeltaCodec.CreatePatch([], []);
        // Magic = 0x54505346 = "FSPT" in little-endian
        Assert.Equal((byte)'F', patch[0]);
        Assert.Equal((byte)'S', patch[1]);
        Assert.Equal((byte)'P', patch[2]);
        Assert.Equal((byte)'T', patch[3]);
    }

    [Fact]
    public void CreatePatch_VersionIsThree()
    {
        byte[] patch = SearchIndexDeltaCodec.CreatePatch([], []);
        // Version at offset 4, LE uint32 = 3
        uint version = System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(patch.AsSpan(4, 4));
        Assert.Equal(3u, version);
    }
}
