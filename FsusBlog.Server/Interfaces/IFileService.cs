using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces
{
    public interface IFileService
    {
        Task<FileUploadResult> UploadImageAsync(IFormFile file);
        Task<bool> DeleteImageAsync(string imageUrl);
    }
}
