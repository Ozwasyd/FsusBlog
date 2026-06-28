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
public readonly struct UploadInitPod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly Utf8Fixed256 FileName;
    public readonly Utf8Fixed64 MimeType;
    public readonly Utf8Fixed32 TargetFormat;
    public readonly long TotalBytes;
    public readonly int ChunkSize;
    public readonly int TotalParts;
    public readonly long ExpiresAtUnixMs;
    public readonly Utf8Fixed128 UploadToken;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadStatusPod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly Utf8Fixed32 Status;
    public readonly long TotalBytes;
    public readonly long UploadedBytes;
    public readonly int ChunkSize;
    public readonly int TotalParts;
    public readonly int UploadedPartCount;
    public readonly int NextPartHint;
    public readonly long ExpiresAtUnixMs;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadPartMapPod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly int Count;
    public readonly int Reserved0;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadPartRangePod
{
    public readonly int Start;
    public readonly int End;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadPartAckPod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly int PartNumber;
    public readonly long Offset;
    public readonly int Size;
    public readonly long UploadedBytes;
    public readonly int UploadedPartCount;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadCompletePod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly Utf8Fixed256 Url;
    public readonly Utf8Fixed256 RelativeUrl;
    public readonly Utf8Fixed64 MimeType;
    public readonly long TotalBytes;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadInitRequestPod
{
    public readonly Utf8Fixed256 FileName;
    public readonly Utf8Fixed64 MimeType;
    public readonly Utf8Fixed32 TargetFormat;
    public readonly long TotalBytes;
    public readonly int ChunkSize;
    public readonly Utf8Fixed64 Sha256;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadCompleteRequestPod
{
    public readonly Utf8Fixed64 Sha256;
}

[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PowChallengePod
{
    public readonly Utf8Fixed64 Salt;
    public readonly int Difficulty;
    public readonly long Timestamp;
    public readonly Utf8Fixed128 Signature;
}
