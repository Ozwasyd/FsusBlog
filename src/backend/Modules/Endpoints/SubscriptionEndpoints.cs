using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static class SubscriptionEndpoints
{
    public static async Task<SiteSubscriptionBinaryResponse?> SubscribeAsync(
        SiteSubscriptionBinaryRequest request,
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        string hash = HashEmail(request.Email);
        if (hash.Length == 0)
        {
            return null;
        }

        string channel = NormalizeChannel(request.Channel);
        SiteSubscription? existing = await db.Queryable<SiteSubscription>()
            .Where(it => it.EmailHash == hash)
            .FirstAsync(cancellationToken);
        if (existing is null)
        {
            await db.Insertable(new SiteSubscription
            {
                EmailHash = hash,
                Channel = channel,
                IsEnabled = true,
                CreatedAt = DateTime.UtcNow
            }).ExecuteCommandAsync(cancellationToken);
        }
        else
        {
            existing.IsEnabled = true;
            existing.UnsubscribedAt = null;
            existing.Channel = channel;
            await db.Updateable(existing).ExecuteCommandAsync(cancellationToken);
        }

        return new SiteSubscriptionBinaryResponse(true, false, channel);
    }

    public static async Task<SiteSubscriptionBinaryResponse?> UnsubscribeAsync(
        SiteSubscriptionBinaryRequest request,
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        string hash = HashEmail(request.Email);
        if (hash.Length == 0)
        {
            return null;
        }

        string channel = NormalizeChannel(request.Channel);
        int count = await db.Updateable<SiteSubscription>()
            .SetColumns(it => it.IsEnabled == false)
            .SetColumns(it => it.UnsubscribedAt == DateTime.UtcNow)
            .Where(it => it.EmailHash == hash)
            .ExecuteCommandAsync(cancellationToken);
        return new SiteSubscriptionBinaryResponse(false, count > 0, channel);
    }

    private static string HashEmail(string? email)
    {
        string normalized = email?.Trim().ToLowerInvariant() ?? string.Empty;
        if (normalized.Length < 5 || !normalized.Contains('@', StringComparison.Ordinal))
        {
            return string.Empty;
        }

        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalized))).ToLowerInvariant();
    }

    private static string NormalizeChannel(string? channel)
        => string.Equals(channel, "email", StringComparison.OrdinalIgnoreCase) ? "email" : "rss";
}
