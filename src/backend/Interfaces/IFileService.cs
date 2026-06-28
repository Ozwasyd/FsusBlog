using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces
{
    public interface IFileService
    {
        Task<FileUploadResult> UploadImageAsync(IFormFile file);
        Task<Result<UploadInitDto>> InitUploadSessionAsync(UploadInitRequestDto dto, CancellationToken cancellationToken = default);
        Task<Result<UploadStatusDto>> GetUploadStatusAsync(string uploadId, CancellationToken cancellationToken = default);
        Task<Result<UploadPartMapDto>> GetUploadPartMapAsync(string uploadId, CancellationToken cancellationToken = default);
        Task<bool> ValidateUploadSessionTokenAsync(string uploadId, string? uploadToken, CancellationToken cancellationToken = default);
        Task<Result<UploadPartAckDto>> UploadPartAsync(string uploadId, int partNumber, long offset, IFormFile part, string? payloadHash, CancellationToken cancellationToken = default);
        Task<Result<UploadCompleteDto>> CompleteUploadAsync(string uploadId, string? sha256, CancellationToken cancellationToken = default);
        Task<Result<bool>> AbortUploadAsync(string uploadId, CancellationToken cancellationToken = default);
        Task<bool> DeleteImageAsync(string imageUrl);
    }
}
