using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>FileUploadOutput</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct FileUploadOutputPod
{
    public readonly Utf8Fixed256 Url;
    public readonly Utf8Fixed256 RelativeUrl;
    public readonly Utf8Fixed128 Message;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadInit</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadStatus</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadPartMap</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadPartMapPod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly int Count;
    public readonly int Reserved0;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadPartRange</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadPartRangePod
{
    public readonly int Start;
    public readonly int End;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadPartAck</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadComplete</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadCompletePod
{
    public readonly Utf8Fixed64 UploadId;
    public readonly Utf8Fixed256 Url;
    public readonly Utf8Fixed256 RelativeUrl;
    public readonly Utf8Fixed64 MimeType;
    public readonly long TotalBytes;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadInitRequest</c> wire contract.
/// </summary>
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

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>UploadCompleteRequest</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadCompleteRequestPod
{
    public readonly Utf8Fixed64 Sha256;
}

/// <summary>
/// Defines the fixed-layout binary representation used by the <c>PowChallenge</c> wire contract.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct PowChallengePod
{
    public readonly Utf8Fixed64 Salt;
    public readonly int Difficulty;
    public readonly long Timestamp;
    public readonly Utf8Fixed128 Signature;
}
