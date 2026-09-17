using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>SiteSubscriptionRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SiteSubscriptionRequestPod
{
    public readonly Utf8Fixed256 Email;
    public readonly Utf8Fixed32 Channel;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>SiteSubscriptionResponse</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SiteSubscriptionResponsePod
{
    public readonly byte Subscribed;
    public readonly byte Unsubscribed;
    public readonly ushort Reserved0;
    public readonly Utf8Fixed32 Channel;
}
