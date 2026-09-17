namespace FsusBlog.Core.Mapping.Models;

public readonly record struct UploadInitRequestCoreModel(
    string FileName,
    string MimeType,
    string TargetFormat,
    long TotalBytes,
    int ChunkSize,
    string? Sha256);

public readonly record struct UploadCompleteRequestCoreModel(string? Sha256);
