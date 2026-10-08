using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>96-byte fixed observation followed by a bounded length-prefixed UTF-8 owner/site blob.</summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct WritingAidPreferenceSnapshotPod
{
    public readonly int SchemaVersion;
    public readonly byte FocusEnabled;
    public readonly byte TypewriterEnabled;
    public readonly byte ImmersiveEnabled;
    public readonly byte Reserved0;
    public readonly long Revision;
    public readonly Utf8SliceRef UserScope;
    public readonly Utf8SliceRef SiteScope;
    public readonly Utf8Fixed64 ContentDigest;
}

/// <summary>80-byte command; operation identity is a canonical lowercase UUID followed by zero padding.</summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct WritingAidPreferenceUpdateRequestPod
{
    public readonly long ExpectedRevision;
    public readonly int SchemaVersion;
    public readonly byte FocusEnabled;
    public readonly byte TypewriterEnabled;
    public readonly byte ImmersiveEnabled;
    public readonly byte Reserved0;
    public readonly Utf8Fixed64 OperationId;
}
