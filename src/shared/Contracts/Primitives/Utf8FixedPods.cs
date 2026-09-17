using System.Runtime.InteropServices;

namespace FsusBlog.Shared.Contracts.Primitives;

/// <summary>
/// Represents a fixed-width 32-byte UTF-8 field in the binary protocol.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct Utf8Fixed32
{
    public readonly ulong B0;
    public readonly ulong B1;
    public readonly ulong B2;
    public readonly ulong B3;
}

/// <summary>
/// Represents a fixed-width 64-byte UTF-8 field in the binary protocol.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct Utf8Fixed64
{
    public readonly ulong B0;
    public readonly ulong B1;
    public readonly ulong B2;
    public readonly ulong B3;
    public readonly ulong B4;
    public readonly ulong B5;
    public readonly ulong B6;
    public readonly ulong B7;
}

/// <summary>
/// Represents a fixed-width 128-byte UTF-8 field in the binary protocol.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct Utf8Fixed128
{
    public readonly Utf8Fixed64 Low;
    public readonly Utf8Fixed64 High;
}

/// <summary>
/// Represents a fixed-width 256-byte UTF-8 field in the binary protocol.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct Utf8Fixed256
{
    public readonly Utf8Fixed128 Low;
    public readonly Utf8Fixed128 High;
}

/// <summary>
/// Represents a fixed-width 512-byte UTF-8 field in the binary protocol.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct Utf8Fixed512
{
    public readonly Utf8Fixed256 Low;
    public readonly Utf8Fixed256 High;
}

/// <summary>
/// Identifies an offset and length inside a shared UTF-8 payload blob.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct Utf8SliceRef
{
    public readonly int Offset;
    public readonly int Length;
}
