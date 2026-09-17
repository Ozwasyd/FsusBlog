using System.Globalization;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class MessageCacheService(
    ICacheCounterStore counters,
    ICacheStringWriter stringWriter,
    ICacheCompareExchangeStore compareExchange,
    ICacheStringReader stringReader)
{
    private const int UnreadRefreshMaxAttempts = 3;

    public ValueTask IncrementUnreadAsync(long accountId)
        => new(counters.IncrementAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId)));

    public ValueTask SetUnreadAsync(long accountId, int unread)
        => new(stringWriter.SetStringAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId), Math.Max(0, unread).ToString(CultureInfo.InvariantCulture)));

    public async ValueTask<int> RefreshUnreadAsync(long accountId, Func<Task<int>> loadUnreadAsync)
    {
        for (int attempt = 0; attempt < UnreadRefreshMaxAttempts; attempt++)
        {
            long version = await counters.IncrementAsync(CachePolicyId.MessageUnread, BuildRefreshVersionIdentity(accountId));
            int unread = Math.Max(0, await loadUnreadAsync());
            bool updated = await compareExchange.TrySetStringIfValueAsync(
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

    public async ValueTask<int> GetUnreadOrRecoverAsync(long accountId, Func<Task<int>> loadUnreadAsync)
    {
        string? cached = null;
        try
        {
            cached = await stringReader.GetStringAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId));
        }
        catch
        {
            // Redis is a discardable projection; database recovery below remains authoritative.
        }

        if (int.TryParse(cached, NumberStyles.None, CultureInfo.InvariantCulture, out int unread) && unread >= 0)
        {
            return unread;
        }

        return await RefreshUnreadAsync(accountId, loadUnreadAsync);
    }

    private static string BuildAccountIdentity(long accountId)
        => $"account:{accountId}";

    private static string BuildRefreshVersionIdentity(long accountId)
        => $"account:{accountId}:refresh-version";
}
