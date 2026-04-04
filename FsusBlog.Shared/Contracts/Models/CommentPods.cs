using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Envelopes;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentItemPod
{
    public readonly long Id;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8Fixed64 UserName;
    public readonly Utf8SliceRef Content;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UserCommentPod
{
    public readonly long Id;
    public readonly int ArticleId;
    public readonly long CreateTimeUnixMs;
    public readonly Utf8SliceRef Content;
    public readonly Utf8Fixed256 ArticleTitle;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct CommentListResponsePod
{
    public readonly CursorPodEnvelope Envelope;
}
