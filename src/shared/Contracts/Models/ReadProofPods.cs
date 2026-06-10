using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct HumanReadChallengeRequestPod
{
    public readonly int ArticleId;
    public readonly byte HasArticleId;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef RouteKey;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct HumanReadChallengeResponsePod
{
    public readonly int ArticleId;
    public readonly int MinDwellMs;
    public readonly long IssuedAtUnixMs;
    public readonly long ExpiresAtUnixMs;
    public readonly byte HasArticleId;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Token;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef RouteKey;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct HumanReadSubmitRequestPod
{
    public readonly int ArticleId;
    public readonly int DwellMs;
    public readonly byte HasArticleId;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Token;
    public readonly Utf8SliceRef Scope;
    public readonly Utf8SliceRef RouteKey;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct HumanReadSubmitResponsePod
{
    public readonly byte Counted;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef Status;
}
