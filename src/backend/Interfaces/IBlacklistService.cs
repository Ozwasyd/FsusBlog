namespace FsusBlog.Server.Interfaces;

public readonly record struct BanStateSnapshot(
    bool IsBanned,
    string? ReasonCode,
    string? Message,
    bool IsKnown = true,
    bool IsDeleted = false,
    long Generation = 0);

public interface IBlacklistService
{
    Task BanUserAsync(int userId, string? reason);
    Task UnbanUserAsync(int userId);
    Task<BanStateSnapshot> GetBanStateAsync(int accountId, string accountSubjectHash);
}
