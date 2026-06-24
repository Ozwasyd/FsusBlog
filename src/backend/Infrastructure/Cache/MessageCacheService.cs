using System.Globalization;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class MessageCacheService(IUnifiedCache cache)
{
    private const int UnreadRefreshMaxAttempts = 3;

    public ValueTask IncrementUnreadAsync(long accountId)
        => new(cache.IncrementAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId)));

    public ValueTask DecrementUnreadAsync(long accountId)
        => new(cache.IncrementAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId), -1));

    public async ValueTask<int> GetUnreadCountAsync(long accountId)
    {
        string? value = await cache.GetStringAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId));
        return int.TryParse(value, out int count) ? count : 0;
    }

    public ValueTask UpdateGlobalVersionAsync()
        => new(cache.IncrementAsync(CachePolicyId.MessageGlobalVersion, "main"));

    public async ValueTask<long> GetGlobalVersionAsync()
    {
        string? value = await cache.GetStringAsync(CachePolicyId.MessageGlobalVersion, "main");
        return long.TryParse(value, out long version) ? version : 0;
    }

    public ValueTask ClearUnreadAsync(long accountId)
        => new(cache.SetStringAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId), "0"));

    public ValueTask SetUnreadAsync(long accountId, int unread)
        => new(cache.SetStringAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId), Math.Max(0, unread).ToString(CultureInfo.InvariantCulture)));

    public async ValueTask<int> RefreshUnreadAsync(long accountId, Func<Task<int>> loadUnreadAsync)
    {
        for (int attempt = 0; attempt < UnreadRefreshMaxAttempts; attempt++)
        {
            long version = await cache.IncrementAsync(CachePolicyId.MessageUnread, BuildRefreshVersionIdentity(accountId));
            int unread = Math.Max(0, await loadUnreadAsync());
            bool updated = await cache.TrySetStringIfValueAsync(
                CachePolicyId.MessageUnread,
                BuildAccountIdentity(accountId),
                unread.ToString(CultureInfo.InvariantCulture),
                BuildRefreshVersionIdentity(accountId),
                version.ToString(CultureInfo.InvariantCulture));
            if (updated)
            {
                return unread;
            }
        }

        return Math.Max(0, await loadUnreadAsync());
    }

    private static string BuildAccountIdentity(long accountId)
        => $"account:{accountId}";

    private static string BuildRefreshVersionIdentity(long accountId)
        => $"account:{accountId}:refresh-version";
}
