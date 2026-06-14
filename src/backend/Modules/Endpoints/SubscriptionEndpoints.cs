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
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO site_subscription (email_hash, channel, is_enabled, created_at, unsubscribed_at)
            VALUES (@email_hash, @channel, true, @created_at, NULL)
            ON CONFLICT (email_hash) DO UPDATE
            SET channel = EXCLUDED.channel,
                is_enabled = true,
                unsubscribed_at = NULL;
            """,
            new SugarParameter[]
            {
                new SugarParameter("@email_hash", hash),
                new SugarParameter("@channel", channel),
                new SugarParameter("@created_at", DateTime.UtcNow)
            });

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

        return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)));
    }

    private static string NormalizeChannel(string? channel)
        => string.Equals(channel, "email", StringComparison.OrdinalIgnoreCase) ? "email" : "rss";
}
