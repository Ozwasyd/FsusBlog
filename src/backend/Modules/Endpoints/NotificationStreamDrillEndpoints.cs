using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using Microsoft.Extensions.Hosting;

namespace FsusBlog.Server.Modules.Endpoints;

public static class NotificationStreamDrillEndpoints
{
    private const string DrillPublishPath = "/_fsus/testing/notification-stream/publish";
    private const string DrillSecretHeader = "X-Fsus-Notification-Drill-Secret";
    private const string DrillSecretConfigKey = "NotificationStream:DrillSecret";
    private const string DrillSecretEnvironmentKey = "FSUSBLOG_NOTIFICATION_DRILL_SECRET";
    private const int DefaultEventCount = 96;
    private const int MaxEventCount = 512;
    private const int DefaultPayloadBytes = 1024;
    private const int MaxPayloadBytes = 64 * 1024;

    public static WebApplication MapNotificationStreamDrillEndpoints(this WebApplication app)
    {
        if (!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Test"))
        {
            return app;
        }

        app.MapPost(DrillPublishPath, PublishAsync)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));

        return app;
    }

    private static async Task<IResult> PublishAsync(
        HttpContext context,
        IConfiguration configuration,
        INotificationStreamPublisher publisher,
        CancellationToken cancellationToken)
    {
        string? configuredSecret = ResolveDrillSecret(configuration);
        if (string.IsNullOrWhiteSpace(configuredSecret))
        {
            return Results.NotFound();
        }

        string providedSecret = context.Request.Headers[DrillSecretHeader].ToString();
        if (!SecretEquals(configuredSecret, providedSecret))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        NotificationStreamDrillPublishRequest? request;
        try
        {
            request = await context.Request.ReadFromJsonAsync<NotificationStreamDrillPublishRequest>(cancellationToken: cancellationToken);
        }
        catch (JsonException)
        {
            return Results.BadRequest(new NotificationStreamDrillErrorResponse("invalid_request"));
        }

        int count = Clamp(request?.Count, DefaultEventCount, 1, MaxEventCount);
        int payloadBytes = Clamp(request?.PayloadBytes, DefaultPayloadBytes, 0, MaxPayloadBytes);
        string drillId = string.IsNullOrWhiteSpace(request?.DrillId)
            ? Guid.NewGuid().ToString("N")
            : request.DrillId.Trim();
        NotificationStreamTarget target = ResolveTarget(request?.RouteKey);
        Result<string> routeResult = NotificationStreamTargetRouteCodec.TryEncode(target);
        if (routeResult.IsFailure || string.IsNullOrWhiteSpace(routeResult.Value))
        {
            return Results.BadRequest(new NotificationStreamDrillErrorResponse("invalid_route"));
        }

        string routeKey = routeResult.Value;
        string body = payloadBytes == 0 ? string.Empty : new string('x', payloadBytes);
        long[] eventIds = new long[count];
        for (int i = 0; i < count; i++)
        {
            var payload = new NotificationStreamDrillPayload(
                drillId,
                i + 1,
                routeKey,
                body,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            Result<NotificationStreamCursor> published = await publisher.PublishAsync(
                NotificationStreamEventType.CacheControl,
                payload,
                target,
                cancellationToken);
            if (published.IsFailure)
            {
                return Results.Problem(
                    title: "notification_stream_drill_publish_failed",
                    detail: published.Error.Message,
                    statusCode: StatusCodes.Status500InternalServerError);
            }

            eventIds[i] = published.Value.Value;
        }

        return Results.Ok(new NotificationStreamDrillPublishResponse(
            "ok",
            drillId,
            routeKey,
            NotificationStreamEventType.CacheControl.ToString(),
            count,
            eventIds));
    }

    private static string? ResolveDrillSecret(IConfiguration configuration)
    {
        string? secret = configuration[DrillSecretConfigKey];
        if (string.IsNullOrWhiteSpace(secret))
        {
            secret = configuration[DrillSecretEnvironmentKey]
                ?? Environment.GetEnvironmentVariable(DrillSecretEnvironmentKey);
        }

        return string.IsNullOrWhiteSpace(secret) ? null : secret;
    }

    private static bool SecretEquals(string expected, string provided)
    {
        if (string.IsNullOrEmpty(provided))
        {
            return false;
        }

        byte[] expectedBytes = System.Text.Encoding.UTF8.GetBytes(expected);
        byte[] providedBytes = System.Text.Encoding.UTF8.GetBytes(provided);
        return expectedBytes.Length == providedBytes.Length
            && CryptographicOperations.FixedTimeEquals(expectedBytes, providedBytes);
    }

    private static NotificationStreamTarget ResolveTarget(string? routeKey)
    {
        string value = string.IsNullOrWhiteSpace(routeKey) ? "content-feed" : routeKey.Trim();
        return value switch
        {
            "content-feed" or "public" or NotificationStreamGroups.ContentFeed or "g:" + NotificationStreamGroups.ContentFeed
                => new NotificationStreamGroupTarget(NotificationStreamGroups.ContentFeed),
            "authenticated-users" or NotificationStreamGroups.AuthenticatedUsers or "g:" + NotificationStreamGroups.AuthenticatedUsers
                => new NotificationStreamGroupTarget(NotificationStreamGroups.AuthenticatedUsers),
            "admin-users" or NotificationStreamGroups.AdminUsers or "g:" + NotificationStreamGroups.AdminUsers
                => new NotificationStreamGroupTarget(NotificationStreamGroups.AdminUsers),
            _ => new NotificationStreamGroupTarget(NotificationStreamGroups.ContentFeed)
        };
    }

    private static int Clamp(int? value, int fallback, int min, int max)
        => Math.Clamp(value ?? fallback, min, max);

    private sealed record NotificationStreamDrillPublishRequest(
        string? DrillId,
        int? Count,
        int? PayloadBytes,
        string? RouteKey);

    private sealed record NotificationStreamDrillPayload(
        string DrillId,
        int Sequence,
        string RouteKey,
        string Body,
        long PublishedAtUnixMs);

    private sealed record NotificationStreamDrillPublishResponse(
        string Status,
        string DrillId,
        string RouteKey,
        string EventType,
        int Count,
        IReadOnlyList<long> EventIds);

    private sealed record NotificationStreamDrillErrorResponse(string Error);
}
