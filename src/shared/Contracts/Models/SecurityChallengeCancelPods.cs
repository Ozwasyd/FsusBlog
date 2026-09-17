using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed header and shared UTF-8 blob references for an envelope cancellation request.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeCancelRequestPod
{
    public readonly Utf8SliceRef EnvelopeId;
    public readonly Utf8SliceRef Action;
    public readonly Utf8SliceRef RouteKey;
    public readonly Utf8SliceRef DeviceFingerprint;
    public readonly Utf8SliceRef PolicyVersion;
}
