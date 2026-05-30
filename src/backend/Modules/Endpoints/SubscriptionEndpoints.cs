using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Dtos;
using Microsoft.AspNetCore.Mvc;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static class SubscriptionEndpoints
{
    public sealed record SiteSubscriptionRequest(string Email, string? Channel);

    public static IEndpointRouteBuilder MapSubscriptionEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/subscriptions")
            .WithTags("Subscriptions")
            .AllowAnonymous();

        group.MapPost("/", async ([FromBody] SiteSubscriptionRequest request, [FromServices] ISqlSugarClient db, CancellationToken cancellationToken) =>
        {
            string hash = HashEmail(request.Email);
            if (hash.Length == 0)
            {
                return Results.BadRequest(JsonApiResponse<object>.Fail("email_invalid"));
            }

            SiteSubscription? existing = await db.Queryable<SiteSubscription>()
                .Where(it => it.EmailHash == hash)
                .FirstAsync(cancellationToken);
            if (existing is null)
            {
                await db.Insertable(new SiteSubscription
                {
                    EmailHash = hash,
                    Channel = NormalizeChannel(request.Channel),
                    IsEnabled = true,
                    CreatedAt = DateTime.UtcNow
                }).ExecuteCommandAsync(cancellationToken);
            }
            else
            {
                existing.IsEnabled = true;
                existing.UnsubscribedAt = null;
                existing.Channel = NormalizeChannel(request.Channel);
                await db.Updateable(existing).ExecuteCommandAsync(cancellationToken);
            }

            return Results.Ok(JsonApiResponse<object>.Ok(new { subscribed = true, channel = NormalizeChannel(request.Channel) }));
        });

        group.MapDelete("/", async ([FromBody] SiteSubscriptionRequest request, [FromServices] ISqlSugarClient db, CancellationToken cancellationToken) =>
        {
            string hash = HashEmail(request.Email);
            if (hash.Length == 0)
            {
                return Results.BadRequest(JsonApiResponse<object>.Fail("email_invalid"));
            }

            int count = await db.Updateable<SiteSubscription>()
                .SetColumns(it => it.IsEnabled == false)
                .SetColumns(it => it.UnsubscribedAt == DateTime.UtcNow)
                .Where(it => it.EmailHash == hash)
                .ExecuteCommandAsync(cancellationToken);
            return Results.Ok(JsonApiResponse<object>.Ok(new { unsubscribed = count > 0 }));
        });

        return app;
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
