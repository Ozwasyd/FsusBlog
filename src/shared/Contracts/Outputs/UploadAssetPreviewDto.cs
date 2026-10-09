namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>Session-authorized current public asset facts and bytes, not article or Vault execution authority.</summary>
public sealed record UploadAssetPreviewDto
{
    public const string SchemaName = "fsusblog.upload-asset-preview.v1";
    public const int HeaderBytes = 760;
    public const int MaxPreviewFrameBytes = 8 * 1024 * 1024;
    public const int MaxPreviewBytes = MaxPreviewFrameBytes - AedsFrameHeader.Size - HeaderBytes;
    public string Schema { get; init; } = SchemaName;
    public required string UploadId
    {
        get; init;
    }
    public required string AssetId
    {
        get; init;
    }
    public required string PublicUrl
    {
        get; init;
    }
    public required string MimeType
    {
        get; init;
    }
    public required string Extension
    {
        get; init;
    }
    public long SizeBytes
    {
        get; init;
    }
    public int Width
    {
        get; init;
    }
    public int Height
    {
        get; init;
    }
    public required string Sha256
    {
        get; init;
    }
    public required string AssetVersionSha256
    {
        get; init;
    }
    public required string ReferenceLedgerSha256
    {
        get; init;
    }
    public int ReferenceRowCount
    {
        get; init;
    }
    public ReadOnlyMemory<byte> Bytes
    {
        get; init;
    }
}
