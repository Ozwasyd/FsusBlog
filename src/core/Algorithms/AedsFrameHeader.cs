using System.Runtime.InteropServices;

namespace FsusBlog.Core.Algorithms;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AedsFrameHeader(
    uint magic,
    byte version,
    byte headerLength,
    ushort flags,
    ushort frameType,
    uint payloadLength,
    ushort payloadCrc16)
{
    public const int Size = 16;
    public const byte CurrentVersion = 2;
    public const byte CurrentHeaderLength = Size;

    public uint Magic { get; } = magic;
    public byte Version { get; } = version;
    public byte HeaderLength { get; } = headerLength;
    public ushort Flags { get; } = flags;
    public ushort FrameType { get; } = frameType;
    public uint PayloadLength { get; } = payloadLength;
    public ushort PayloadCrc16 { get; } = payloadCrc16;
}
