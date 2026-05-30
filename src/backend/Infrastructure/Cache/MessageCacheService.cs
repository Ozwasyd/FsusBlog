namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class MessageCacheService(IUnifiedCache cache)
{
    public ValueTask IncrementUnreadAsync(long userId)
        => new(cache.IncrementAsync(CachePolicyId.MessageUnread, userId.ToString()));

    public ValueTask DecrementUnreadAsync(long userId)
        => new(cache.IncrementAsync(CachePolicyId.MessageUnread, userId.ToString(), -1));

    public async ValueTask<int> GetUnreadCountAsync(long userId)
    {
        string? value = await cache.GetStringAsync(CachePolicyId.MessageUnread, userId.ToString());
        return int.TryParse(value, out int count) ? count : 0;
    }

    public ValueTask UpdateGlobalVersionAsync()
        => new(cache.IncrementAsync(CachePolicyId.MessageGlobalVersion, "main"));

    public async ValueTask<long> GetGlobalVersionAsync()
    {
        string? value = await cache.GetStringAsync(CachePolicyId.MessageGlobalVersion, "main");
        return long.TryParse(value, out long version) ? version : 0;
    }

    public ValueTask ClearUnreadAsync(long userId)
        => new(cache.SetStringAsync(CachePolicyId.MessageUnread, userId.ToString(), "0"));

    public ValueTask SetUnreadAsync(long userId, int unread)
        => new(cache.SetStringAsync(CachePolicyId.MessageUnread, userId.ToString(), Math.Max(0, unread).ToString()));
}
