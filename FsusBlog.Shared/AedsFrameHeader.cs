using System.Runtime.InteropServices;

namespace FsusBlog.Shared;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct AedsFrameHeader
{
    public const int Size = 24;
    public const uint Magic = 0x53444541; // "AEDS" little-endian

    public readonly uint MagicValue;
    public readonly ushort Version;
    public readonly ushort FrameType;
    public readonly uint Flags;
    public readonly uint PayloadLength;
    public readonly uint HeaderCrc32;
    public readonly uint PayloadCrc32;
}

public enum AedsFrameType : ushort
{
    Unknown = 0,
    ArticleList = 1,
    ArticleDetail = 2,
    ArticleHot = 3,
    ArticleSearch = 4,
    CommentArticleCursor = 5,
    CommentUserCursor = 6,
    AdminStats = 7
}
