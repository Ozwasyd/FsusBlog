using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Fixed layout binary pod for a PerceptionCharacter V3 issue response.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PerceptionCharacterV3IssuePod
{
    public readonly byte Representation;
    public readonly byte AttemptBudget;
    public readonly ushort PhysicalWidth;
    public readonly ushort PhysicalHeight;
    public readonly ushort DisplayWidth;
    public readonly ushort DisplayHeight;
    public readonly ushort Reserved;
    public readonly int MediaByteCount;
    public readonly long IssuedAtUnixMs;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed64 ChallengeId;
    public readonly Utf8Fixed64 EnvelopeId;
    public readonly Utf8Fixed64 PolicyVersion;
    public readonly Utf8SliceRef Algorithm;
    public readonly Utf8SliceRef MediaType;
    public readonly Utf8SliceRef MediaBytes;
    public readonly Utf8SliceRef StateToken;
}

/// <summary>
/// Fixed layout binary pod for a PerceptionCharacter V3 verify request.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PerceptionCharacterV3VerifyPod
{
    public readonly byte Representation;
    public readonly byte Reserved0;
    public readonly ushort Reserved1;
    public readonly Utf8Fixed64 ChallengeId;
    public readonly Utf8Fixed64 EnvelopeId;
    public readonly Utf8SliceRef Algorithm;
    public readonly Utf8SliceRef Answer;
    public readonly Utf8SliceRef StateToken;
}
