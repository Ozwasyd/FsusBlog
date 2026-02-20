namespace FsusBlog.Server.Interfaces;

public interface IBlacklistService
{
    Task BanUserAsync(int userId, string? reason);
    Task UnbanUserAsync(int userId);
    Task<string?> GetBanReasonAsync(int userId);
    Task<bool> IsBannedAsync(int userId);
}
