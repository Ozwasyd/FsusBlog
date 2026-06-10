using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SiteSubscriptionRequestPod
{
    public readonly Utf8Fixed256 Email;
    public readonly Utf8Fixed32 Channel;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SiteSubscriptionResponsePod
{
    public readonly byte Subscribed;
    public readonly byte Unsubscribed;
    public readonly ushort Reserved0;
    public readonly Utf8Fixed32 Channel;
}
