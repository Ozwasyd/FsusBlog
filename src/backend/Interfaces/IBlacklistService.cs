namespace FsusBlog.Server.Interfaces;

public readonly record struct BanStateSnapshot(bool IsBanned, string? ReasonCode, string? Message);

public interface IBlacklistService
{
    Task BanUserAsync(int userId, string? reason);
    Task UnbanUserAsync(int userId);
    Task<BanStateSnapshot> GetBanStateAsync(int userId);
}
