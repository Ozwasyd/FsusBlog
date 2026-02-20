using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Interfaces
{
    public interface IFileService
    {
        Task<FileUploadResult> UploadImageAsync(IFormFile file);
        Task<bool> DeleteImageAsync(string imageUrl);
    }
}
