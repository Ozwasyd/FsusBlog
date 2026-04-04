using System.Runtime.InteropServices;

namespace FsusBlog.Core.Algorithms;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AedsFrameHeader(
    uint magic,
    ushort version,
    ushort frameType,
    uint flags,
    uint payloadLength,
    uint headerCrc32,
    uint payloadCrc32)
{
    public const int Size = 24;

    public uint Magic { get; } = magic;
    public ushort Version { get; } = version;
    public ushort FrameType { get; } = frameType;
    public uint Flags { get; } = flags;
    public uint PayloadLength { get; } = payloadLength;
    public uint HeaderCrc32 { get; } = headerCrc32;
    public uint PayloadCrc32 { get; } = payloadCrc32;
}
