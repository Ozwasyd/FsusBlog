using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.Subscriptions;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Configuration;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static class SubscriptionEndpoints
{
    private const int MaxEmailChars = 254;

    public static async Task<SiteSubscriptionBinaryResponse?> SubscribeAsync(
        SiteSubscriptionBinaryRequest request,
        ISqlSugarClient db,
        IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (request.Email.Length > MaxEmailChars)
        {
            return null;
        }

        string hash = SiteSubscriptionIdentity.HashEmail(request.Email, configuration);
        if (hash.Length == 0)
        {
            return null;
        }

        string legacyHash = SiteSubscriptionIdentity.LegacySha256EmailHash(request.Email);
        string channel = SiteSubscriptionIdentity.NormalizeChannel(request.Channel);
        cancellationToken.ThrowIfCancellationRequested();
        await db.Ado.ExecuteCommandAsync(
            """
            UPDATE site_subscription
            SET email_hash = @email_hash,
                hash_version = @hash_version
            WHERE email_hash = @legacy_email_hash
              AND NOT EXISTS (
                  SELECT 1
                  FROM site_subscription
                  WHERE email_hash = @email_hash
              );

            INSERT INTO site_subscription (email_hash, hash_version, channel, is_enabled, created_at, unsubscribed_at)
            VALUES (@email_hash, @hash_version, @channel, true, @created_at, NULL)
            ON CONFLICT (email_hash) DO UPDATE
            SET channel = EXCLUDED.channel,
                is_enabled = true,
                hash_version = @hash_version,
                unsubscribed_at = NULL;
            """,
            new SugarParameter[]
            {
                new SugarParameter("@email_hash", hash),
                new SugarParameter("@legacy_email_hash", legacyHash),
                new SugarParameter("@hash_version", SiteSubscriptionIdentity.CurrentHashVersion),
                new SugarParameter("@channel", channel),
                new SugarParameter("@created_at", DateTime.UtcNow)
            });

        return new SiteSubscriptionBinaryResponse(true, false, channel);
    }

    public static async Task<SiteSubscriptionBinaryResponse?> UnsubscribeAsync(
        SiteSubscriptionBinaryRequest request,
        ISqlSugarClient db,
        SiteSubscriptionUnsubscribeProofClaims proof,
        IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (request.Email.Length > MaxEmailChars)
        {
            return null;
        }

        string hash = SiteSubscriptionIdentity.HashEmail(request.Email, configuration);
        if (hash.Length == 0)
        {
            return null;
        }

        string legacyHash = SiteSubscriptionIdentity.LegacySha256EmailHash(request.Email);
        string channel = SiteSubscriptionIdentity.NormalizeChannel(request.Channel);
        if (!string.Equals(hash, proof.EmailHash, StringComparison.Ordinal) ||
            !string.Equals(channel, proof.Channel, StringComparison.Ordinal))
        {
            return null;
        }

        int count = await db.Updateable<SiteSubscription>()
            .SetColumns(it => it.IsEnabled == false)
            .SetColumns(it => it.UnsubscribedAt == DateTime.UtcNow)
            .Where(it => (it.EmailHash == proof.EmailHash || it.EmailHash == legacyHash) && it.Channel == proof.Channel)
            .ExecuteCommandAsync(cancellationToken);
        return new SiteSubscriptionBinaryResponse(false, count > 0, channel);
    }
}
