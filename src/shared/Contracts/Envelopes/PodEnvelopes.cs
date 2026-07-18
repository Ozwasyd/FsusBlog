using System.Runtime.InteropServices;

namespace FsusBlog.Shared.Contracts.Envelopes;

/// <summary>
/// Defines the fixed-layout header shared by every binary POD envelope.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PodEnvelopeHeader
{
    public readonly int Version;
    public readonly int Count;
    public readonly int PayloadLength;
    public readonly int Reserved;
}

/// <summary>
/// Defines fixed-layout pagination metadata for a binary POD page.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PageEnvelope
{
    public readonly int Total;
    public readonly int Count;
}

/// <summary>
/// Defines fixed-layout cursor metadata for a binary POD page.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CursorEnvelope
{
    public readonly long NextCursor;
    public readonly byte HasMore;
    public readonly byte Reserved0;
    public readonly byte Reserved1;
    public readonly byte Reserved2;
}

/// <summary>
/// Combines page metadata with a contiguous fixed-layout POD payload.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PagedPodEnvelope
{
    public readonly PodEnvelopeHeader Header;
    public readonly PageEnvelope Page;
}

/// <summary>
/// Combines cursor metadata with a contiguous fixed-layout POD payload.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CursorPodEnvelope
{
    public readonly PodEnvelopeHeader Header;
    public readonly CursorEnvelope Cursor;
}
