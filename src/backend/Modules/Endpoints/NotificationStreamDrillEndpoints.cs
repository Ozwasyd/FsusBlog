using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Cache;
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
    private const string DrillTimestampHeader = "X-Fsus-Notification-Drill-Timestamp";
    private const string DrillNonceHeader = "X-Fsus-Notification-Drill-Nonce";
    private const string DrillSignatureHeader = "X-Fsus-Notification-Drill-Signature";
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
        IUnifiedCache cache,
        INotificationStreamPublisher publisher,
        CancellationToken cancellationToken)
    {
        string? configuredSecret = ResolveDrillSecret(configuration);
        if (string.IsNullOrWhiteSpace(configuredSecret))
        {
            return Results.NotFound();
        }

        string body = await ReadRequestBodyAsync(context.Request, cancellationToken);
        if (!await ValidateSignedDrillRequestAsync(context, cache, configuredSecret, body, cancellationToken))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        NotificationStreamDrillPublishRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<NotificationStreamDrillPublishRequest>(body);
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
        string eventBody = payloadBytes == 0 ? string.Empty : new string('x', payloadBytes);
        long[] eventIds = new long[count];
        for (int i = 0; i < count; i++)
        {
            var payload = new NotificationStreamDrillPayload(
                drillId,
                i + 1,
                routeKey,
                eventBody,
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

    private static async Task<bool> ValidateSignedDrillRequestAsync(
        HttpContext context,
        IUnifiedCache cache,
        string secret,
        string body,
        CancellationToken cancellationToken)
    {
        if (!SecretEquals(secret, context.Request.Headers[DrillSecretHeader].ToString()))
        {
            return false;
        }

        string timestampValue = context.Request.Headers[DrillTimestampHeader].ToString();
        string nonce = context.Request.Headers[DrillNonceHeader].ToString().Trim();
        string providedSignature = context.Request.Headers[DrillSignatureHeader].ToString().Trim();
        if (!long.TryParse(timestampValue, NumberStyles.Integer, CultureInfo.InvariantCulture, out long timestampUnixSeconds) ||
            nonce.Length is < 16 or > 128 ||
            providedSignature.Length == 0)
        {
            return false;
        }

        DateTimeOffset timestamp = DateTimeOffset.FromUnixTimeSeconds(timestampUnixSeconds);
        if (DateTimeOffset.UtcNow - timestamp > TimeSpan.FromSeconds(60) ||
            timestamp - DateTimeOffset.UtcNow > TimeSpan.FromSeconds(60))
        {
            return false;
        }

        string expectedSignature = ComputeDrillSignature(secret, timestampValue, nonce, body);
        if (!SecretEquals(expectedSignature, providedSignature))
        {
            return false;
        }

        string nonceIdentity = $"{timestampValue}:{nonce}";
        return await cache.TryAcquireLeaseAsync(CachePolicyId.NotificationStreamDrillNonce, nonceIdentity, "1", TimeSpan.FromSeconds(60), cancellationToken);
    }

    private static string ComputeDrillSignature(string secret, string timestamp, string nonce, string body)
    {
        byte[] key = Encoding.UTF8.GetBytes(secret);
        byte[] payload = Encoding.UTF8.GetBytes($"{timestamp}\n{nonce}\n{body}");
        byte[] signature = HMACSHA256.HashData(key, payload);
        return Convert.ToHexStringLower(signature);
    }

    private static async Task<string> ReadRequestBodyAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(request.Body, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: false);
        return await reader.ReadToEndAsync(cancellationToken);
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
            "content-feed" or "public" or "g:" + NotificationStreamTargetCollections.ContentFeed
                => new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed),
            "admin-users" or "g:" + NotificationStreamTargetCollections.AdminUsers
                => new NotificationStreamGroupTarget(NotificationStreamTargetCollections.AdminUsers),
            _ => new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed)
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
