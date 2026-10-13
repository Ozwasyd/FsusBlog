using FsusBlog.Core.Common;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces
{
    public interface IFileService
    {
        Task<Result<UploadInitDto>> InitUploadSessionAsync(long ownerAdminPrincipalId, UploadInitRequestDto dto, CancellationToken cancellationToken = default);
        Task<Result<UploadStatusDto>> GetUploadStatusAsync(UploadSessionAccess access, CancellationToken cancellationToken = default);
        Task<Result<UploadPartMapDto>> GetUploadPartMapAsync(UploadSessionAccess access, CancellationToken cancellationToken = default);
        Task<Result<UploadPartAckDto>> UploadPartAsync(UploadSessionAccess access, int partNumber, long offset, IFormFile part, string? payloadHash, CancellationToken cancellationToken = default);
        Task<Result<UploadCompleteDto>> CompleteUploadAsync(UploadSessionAccess access, string? sha256, CancellationToken cancellationToken = default);
        Task<Result<UploadAssetObservation>> ObserveCommittedUploadAsync(UploadSessionAccess access, string sha256, CancellationToken cancellationToken = default);
        // Server-only original session read; this grants no Vault operation or private export right.
        Task<Result<UploadAssetPreview>> ReadCommittedUploadInputAsync(UploadSessionAccess access, string sha256, CancellationToken cancellationToken = default);
        Task<Result<UploadAssetPreview>> ReadCommittedUploadPreviewAsync(UploadSessionAccess access, string sha256, CancellationToken cancellationToken = default);
        Task<Result<bool>> AbortUploadAsync(UploadSessionAccess access, CancellationToken cancellationToken = default);
    }
}
