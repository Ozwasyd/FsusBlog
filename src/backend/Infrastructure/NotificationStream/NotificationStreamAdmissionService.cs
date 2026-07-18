using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamAdmissionService
{
    Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken);
}

internal sealed record NotificationStreamAdmissionResult(bool IsAllowed, int StatusCode, string? ErrorCode)
{
    public static NotificationStreamAdmissionResult Allowed { get; } = new(true, StatusCodes.Status200OK, null);

    public static NotificationStreamAdmissionResult Denied(int statusCode, string errorCode)
        => new(false, statusCode, errorCode);
}

internal sealed class NotificationStreamAdmissionService(
    IBlacklistService blacklistService,
    IUserAccountReader users,
    NotificationStreamAccountAdmissionCache accountCache) : INotificationStreamAdmissionService
{
    public NotificationStreamAdmissionService(IBlacklistService blacklistService, IUserAccountReader users)
        : this(blacklistService, users, new NotificationStreamAccountAdmissionCache())
    {
    }

    public async Task<NotificationStreamAdmissionResult> ValidateAsync(string? userId, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(userId) || !int.TryParse(userId, out int numericUserId))
        {
            return NotificationStreamAdmissionResult.Allowed;
        }

        NotificationStreamAccountAdmissionCacheResult cached = await accountCache.GetOrCreateAsync(
            numericUserId,
            users,
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordNotificationStreamAdmissionAccountState(cached.Hit, cached.LoadedFromDb);

        UserAccountSnapshot? userSnapshot = cached.Account;
        if (userSnapshot == null || userSnapshot.Value.DeletedAt.HasValue || userSnapshot.Value.Status == 2)
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_deleted");
            return NotificationStreamAdmissionResult.Denied(StatusCodes.Status401Unauthorized, "account_deleted");
        }

        if (!AccountSubjectHashRequirement.TryResolve(
                userSnapshot.Value.AccountSubjectHash,
                out string accountSubjectHash))
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_subject_invalid");
            return NotificationStreamAdmissionResult.Denied(
                StatusCodes.Status401Unauthorized,
                "account_subject_invalid");
        }

        var banState = await blacklistService.GetBanStateAsync(numericUserId, accountSubjectHash);
        if (banState.IsBanned)
        {
            FsusObservability.RecordNotificationStreamAdmissionRejected("account_blocked");
            return NotificationStreamAdmissionResult.Denied(StatusCodes.Status423Locked, "account_blocked");
        }

        return NotificationStreamAdmissionResult.Allowed;
    }
}

internal sealed record NotificationStreamAccountAdmissionCacheResult(
    UserAccountSnapshot? Account,
    bool Hit,
    bool LoadedFromDb);

internal sealed class NotificationStreamAccountAdmissionCache
{
    private static readonly TimeSpan s_entryTtl = TimeSpan.FromSeconds(60);
    private readonly ConcurrentDictionary<int, CacheEntry> _entries = new();

    public async Task<NotificationStreamAccountAdmissionCacheResult> GetOrCreateAsync(
        int accountId,
        IUserAccountReader users,
        CancellationToken cancellationToken)
    {
        long nowTicks = DateTimeOffset.UtcNow.UtcTicks;
        if (_entries.TryGetValue(accountId, out CacheEntry? current) && current.ExpiresAtUtcTicks > nowTicks)
        {
            return new NotificationStreamAccountAdmissionCacheResult(current.Account, Hit: true, LoadedFromDb: false);
        }

        cancellationToken.ThrowIfCancellationRequested();
        UserAccountSnapshot? loaded = await users.GetAccountByIdAsync(accountId).ConfigureAwait(false);
        if (loaded.HasValue
            && AccountSubjectHashRequirement.TryResolve(loaded.Value.AccountSubjectHash, out _))
        {
            _entries[accountId] = new CacheEntry(loaded.Value, DateTimeOffset.UtcNow.Add(s_entryTtl).UtcTicks);
        }
        else
        {
            _entries.TryRemove(accountId, out _);
        }

        return new NotificationStreamAccountAdmissionCacheResult(loaded, Hit: false, LoadedFromDb: true);
    }

    private sealed record CacheEntry(UserAccountSnapshot Account, long ExpiresAtUtcTicks);
}
