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

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeIssueRequestPod
{
    public readonly Utf8SliceRef Action;
    public readonly Utf8SliceRef RouteKey;
    public readonly Utf8SliceRef DeviceFingerprint;
    public readonly Utf8SliceRef AttributesJson;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeVerifyRequestPod
{
    public readonly byte Kind;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8SliceRef ChallengeId;
    public readonly Utf8SliceRef Action;
    public readonly Utf8SliceRef RouteKey;
    public readonly Utf8SliceRef ProviderPayloadJson;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeIssueResponsePod
{
    public readonly byte Decision;
    public readonly byte AssignmentCount;
    public readonly ushort ProviderPayloadCount;
    public readonly int RiskScore;
    public readonly int EffectiveRiskScore;
    public readonly int EscalationLevel;
    public readonly int RetryAfterMs;
    public readonly Utf8Fixed64 EnvelopeId;
    public readonly Utf8Fixed64 PolicyVersion;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeProviderPayloadPod
{
    public readonly Utf8Fixed64 ChallengeId;
    public readonly Utf8SliceRef PayloadJson;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct SecurityChallengeVerifyResponsePod
{
    public readonly byte Verified;
    public readonly byte Kind;
    public readonly ushort Reserved0;
    public readonly int RetryAfterMs;
    public readonly Utf8Fixed64 ChallengeId;
    public readonly Utf8Fixed64 PolicyVersion;
    public readonly Utf8SliceRef ProofToken;
    public readonly Utf8SliceRef Reason;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PerceptionSealedChallengeV2Pod
{
    public readonly SecurityChallengeAssignmentPod Assignment;
    public readonly byte TaskKind;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly int GridWidth;
    public readonly int GridHeight;
    public readonly long IssuedAtUnixMs;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed64 Algorithm;
    public readonly Utf8Fixed64 RecipeHashHex;
    public readonly Utf8Fixed64 SignatureHex;
    public readonly Utf8SliceRef RenderRecipeBase64;
    public readonly Utf8SliceRef SealedTokenBase64;
    public readonly Utf8SliceRef Family;
    public readonly Utf8SliceRef Variant;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PerceptionSealedResultV2Pod
{
    public readonly SecurityChallengeAssignmentPod Assignment;
    public readonly byte TaskKind;
    public readonly byte PayloadKind;
    public readonly ushort Reserved0;
    public readonly long IssuedAtUnixMs;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed64 Algorithm;
    public readonly Utf8Fixed64 RecipeHashHex;
    public readonly Utf8Fixed64 SignatureHex;
    public readonly Utf8SliceRef ResponsePayloadBase64;
    public readonly Utf8SliceRef SealedTokenBase64;
}
