namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class MessageCacheService(IUnifiedCache cache)
{
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
        => new(cache.SetStringAsync(CachePolicyId.MessageUnread, BuildAccountIdentity(accountId), Math.Max(0, unread).ToString()));

    private static string BuildAccountIdentity(long accountId)
        => $"account:{accountId}";
}
