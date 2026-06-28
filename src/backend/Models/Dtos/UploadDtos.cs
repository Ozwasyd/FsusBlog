namespace FsusBlog.Server.Models.Dtos;

public sealed record class UploadInitRequestDto
{
    public string FileName { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public string TargetFormat { get; init; } = string.Empty;
    public long TotalBytes { get; init; }
    public int ChunkSize { get; init; }
    public string? Sha256 { get; init; }
}

public sealed record class UploadCompleteRequestDto
{
    public string? Sha256 { get; init; }
}

internal sealed record class UploadSessionRecord
{
    public string UploadId { get; init; } = string.Empty;
    public string FileName { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public string TargetFormat { get; init; } = string.Empty;
    public long TotalBytes { get; init; }
    public int ChunkSize { get; init; }
    public int TotalParts { get; init; }
    public string UploadToken { get; init; } = string.Empty;
    public string? Sha256 { get; init; }
    public string Status { get; set; } = "pending";
    public DateTime CreatedAt { get; init; }
    public DateTime ExpiresAt { get; set; }
    public long UploadedBytes { get; set; }
    public List<int>? UploadedParts { get; set; }
    public string WorkingFileName { get; init; } = string.Empty;
    public string UploadedPartBitmapBase64 { get; set; } = string.Empty;
    public int ManifestCheckpointPartCount { get; set; }
}
