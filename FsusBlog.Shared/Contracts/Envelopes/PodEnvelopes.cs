using System.Runtime.InteropServices;

namespace FsusBlog.Shared.Contracts.Envelopes;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PodEnvelopeHeader
{
    public readonly int Version;
    public readonly int Count;
    public readonly int PayloadLength;
    public readonly int Reserved;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PageEnvelope
{
    public readonly int Total;
    public readonly int Count;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CursorEnvelope
{
    public readonly long NextCursor;
    public readonly byte HasMore;
    public readonly byte Reserved0;
    public readonly byte Reserved1;
    public readonly byte Reserved2;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PagedPodEnvelope
{
    public readonly PodEnvelopeHeader Header;
    public readonly PageEnvelope Page;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CursorPodEnvelope
{
    public readonly PodEnvelopeHeader Header;
    public readonly CursorEnvelope Cursor;
}
