using System.Buffers.Binary;
using FsusBlog.Core.Common;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests;

public sealed class SearchIndexDeltaCodecTests
{
    private const uint PatchMagic = 0x54505346; // FSPT
    private const uint PatchVersion = 2;

    [Fact]
    public void CreatePatch_AppendsMiniShardPayload_AndEncodesProvidedTombstones()
    {
        uint[] tombstones = [1u, 3u, 8u];
        byte[] appendedShard = BuildShardWithArticleIds(3, 9);

        byte[] patch = SearchIndexDeltaCodec.CreatePatch(tombstones, appendedShard);
        ParsedPatch parsed = ParsePatch(patch);

        Assert.Equal(PatchMagic, parsed.Magic);
        Assert.Equal(PatchVersion, parsed.Version);
        Assert.Equal(appendedShard, parsed.Payload);
        Assert.Equal(tombstones, parsed.Tombstones);
    }

    [Fact]
    public void CreatePatch_StillReturnsPatch_ForTombstoneOnlyMiniShard()
    {
        uint[] tombstones = [4u, 5u];
        byte[] appendedShard = BuildShardWithArticleIds();

        byte[] patch = SearchIndexDeltaCodec.CreatePatch(tombstones, appendedShard);
        ParsedPatch parsed = ParsePatch(patch);

        Assert.Equal(PatchMagic, parsed.Magic);
        Assert.Equal(PatchVersion, parsed.Version);
        Assert.Equal(appendedShard, parsed.Payload);
        Assert.Equal(tombstones, parsed.Tombstones);
    }

    [Fact]
    public void CreatePatch_RoundTripsAppendedPayload_ForRandomizedSamples()
    {
        var random = new Random(12345);
        for (int iteration = 0; iteration < 20; iteration++)
        {
            uint[] tombstones = Enumerable.Range(0, random.Next(0, 24))
                .Select(_ => (uint)random.Next(1, 4096))
                .Distinct()
                .OrderBy(id => id)
                .ToArray();
            uint[] appendedIds = Enumerable.Range(0, random.Next(0, 16))
                .Select(_ => (uint)random.Next(1, 4096))
                .Distinct()
                .OrderBy(id => id)
                .ToArray();

            byte[] appendedShard = BuildShardWithArticleIds(appendedIds);
            byte[] patch = SearchIndexDeltaCodec.CreatePatch(tombstones, appendedShard);
            ParsedPatch parsed = ParsePatch(patch);

            Assert.Equal(appendedShard, parsed.Payload);
            Assert.Equal(tombstones, parsed.Tombstones);
        }
    }

    private static ParsedPatch ParsePatch(ReadOnlySpan<byte> patchBytes)
    {
        int offset = 0;
        uint magic = ReadUInt32(patchBytes, ref offset);
        uint version = ReadUInt32(patchBytes, ref offset);
        uint tombstoneCount = ReadUInt32(patchBytes, ref offset);
        uint tombstoneBytes = ReadUInt32(patchBytes, ref offset);
        uint payloadLength = ReadUInt32(patchBytes, ref offset);
        _ = ReadUInt32(patchBytes, ref offset);

        uint[] tombstones = new uint[tombstoneCount];
        uint previous = 0;
        int tombstoneEnd = offset + checked((int)tombstoneBytes);
        for (int i = 0; i < tombstones.Length; i++)
        {
            previous += ReadVInt(patchBytes, ref offset);
            tombstones[i] = previous;
        }

        Assert.Equal(tombstoneEnd, offset);
        byte[] payload = patchBytes.Slice(offset, checked((int)payloadLength)).ToArray();
        return new ParsedPatch(magic, version, tombstones, payload);
    }

    private static byte[] BuildShardWithArticleIds(params uint[] articleIds)
    {
        const uint shardMagic = 0x32534846; // FHS2
        const uint shardVersion = 2;
        const int docMetadataSize = 48;
        int docOffset = 72;
        int totalLength = docOffset + articleIds.Length * docMetadataSize;
        byte[] bytes = new byte[totalLength];
        var span = bytes.AsSpan();

        WriteUInt32(span, 0, shardMagic);
        WriteUInt32(span, 4, shardVersion);
        WriteUInt32(span, 8, 0);
        WriteUInt32(span, 12, 1);
        WriteUInt32(span, 16, 0);
        WriteUInt32(span, 20, checked((uint)articleIds.Length));
        WriteUInt32(span, 24, 0);
        WriteUInt32(span, 28, 0);
        WriteUInt32(span, 32, 0);
        WriteUInt32(span, 36, 0);
        WriteUInt32(span, 40, checked((uint)docOffset));
        WriteUInt32(span, 44, 0);
        WriteUInt32(span, 48, 0);
        WriteUInt32(span, 52, 0);
        WriteUInt32(span, 56, 0);
        WriteUInt32(span, 60, 0);
        WriteUInt32(span, 64, 0);
        WriteUInt32(span, 68, 0);

        for (int index = 0; index < articleIds.Length; index++)
        {
            BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(docOffset + index * docMetadataSize, sizeof(uint)), articleIds[index]);
        }

        return bytes;
    }

    private static void WriteUInt32(Span<byte> span, int offset, uint value)
        => BinaryPrimitives.WriteUInt32LittleEndian(span.Slice(offset, sizeof(uint)), value);

    private static uint ReadUInt32(ReadOnlySpan<byte> value, ref int offset)
    {
        uint result = BinaryPrimitives.ReadUInt32LittleEndian(value[offset..]);
        offset += sizeof(uint);
        return result;
    }

    private static uint ReadVInt(ReadOnlySpan<byte> bytes, ref int offset)
    {
        uint value = 0;
        int shift = 0;
        while (true)
        {
            byte current = bytes[offset++];
            value |= (uint)(current & 0x7F) << shift;
            if ((current & 0x80) == 0)
            {
                return value;
            }

            shift += 7;
        }
    }

    private readonly record struct ParsedPatch(uint Magic, uint Version, uint[] Tombstones, byte[] Payload);
}
