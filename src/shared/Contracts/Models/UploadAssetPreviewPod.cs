using System.Runtime.InteropServices;

using FsusBlog.Shared.Contracts.Primitives;

namespace FsusBlog.Shared.Contracts.Models;

/// <summary>
/// Original 760-byte packed asset metadata header. Preview appends exactly SizeBytes
/// original image bytes; facts-v1 is this fixed metadata payload only, with its own schema.
/// </summary>
[StructLayout(LayoutKind.Sequential, Pack = 1)]
public readonly struct UploadAssetPreviewPod
{
    public readonly Utf8Fixed64 Schema;
    public readonly Utf8Fixed64 UploadId;
    public readonly Utf8Fixed64 AssetId;
    public readonly Utf8Fixed256 PublicUrl;
    public readonly Utf8Fixed64 MimeType;
    public readonly Utf8Fixed32 Extension;
    public readonly long SizeBytes;
    public readonly int Width;
    public readonly int Height;
    public readonly Utf8Fixed64 Sha256;
    public readonly Utf8Fixed64 AssetVersionSha256;
    public readonly Utf8Fixed64 ReferenceLedgerSha256;
    public readonly int ReferenceRowCount;
    public readonly int Reserved0;
}
