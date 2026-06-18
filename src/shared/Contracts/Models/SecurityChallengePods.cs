using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeAssignmentPod
{
    public readonly byte Kind;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly int EscalationLevel;
    public readonly long IssuedAtUnixMs;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed64 ChallengeId;
    public readonly Utf8Fixed128 Traceparent;
    public readonly Utf8Fixed64 TenantId;
    public readonly Utf8Fixed64 Action;
    public readonly Utf8Fixed128 RouteKey;
    public readonly Utf8Fixed64 SubjectHash;
    public readonly Utf8Fixed64 ClientIpHash;
    public readonly Utf8Fixed64 DeviceFpHash;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeEnvelopePod
{
    public readonly int AssignmentCount;
    public readonly Utf8Fixed64 EnvelopeId;
    public readonly Utf8Fixed64 PolicyVersion;
}
