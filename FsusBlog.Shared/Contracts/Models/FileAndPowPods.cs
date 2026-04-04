using System.Runtime.InteropServices;
using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FileUploadOutputPod
{
    public readonly Utf8Fixed256 Url;
    public readonly Utf8Fixed256 RelativeUrl;
    public readonly Utf8Fixed128 Message;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PowChallengePod
{
    public readonly Utf8Fixed64 Salt;
    public readonly int Difficulty;
    public readonly long Timestamp;
    public readonly Utf8Fixed128 Signature;
}
