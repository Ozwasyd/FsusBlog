namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>Session-owned current asset facts, without image bytes, private reference rows or article-operation receipts.</summary>
public sealed record UploadAssetFactsDto
{
    public const string SchemaName = "fsusblog.upload-asset-facts.v1";
    public const int PayloadBytes = UploadAssetPreviewDto.HeaderBytes;
    public const long MaxAssetBytes = 20 * 1024 * 1024;
    public string Schema { get; init; } = SchemaName;
    public required string UploadId { get; init; }
    public required string AssetId { get; init; }
    public required string PublicUrl { get; init; }
    public required string MimeType { get; init; }
    public required string Extension { get; init; }
    public long SizeBytes { get; init; }
    public int Width { get; init; }
    public int Height { get; init; }
    public required string Sha256 { get; init; }
    public required string AssetVersionSha256 { get; init; }
    public required string ReferenceLedgerSha256 { get; init; }
    public int ReferenceRowCount { get; init; }
}
