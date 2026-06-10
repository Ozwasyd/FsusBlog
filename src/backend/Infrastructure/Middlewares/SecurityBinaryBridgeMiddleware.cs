using System.Text;
using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Middlewares;

public sealed class SecurityBinaryBridgeMiddleware
{
    internal const int MaxSecurityFrameBytes = 1024 * 1024;
    private const string BinaryContentType = "application/octet-stream";
    private const string JsonContentType = "application/json";
    private const string BinaryPrefix = "/api/binary/admin/security";
    private const string LegacyPrefix = BinaryBridgeInternalRequest.SecurityPrefix;
    private static readonly byte[] JsonNullPayload = "null"u8.ToArray();

    private readonly RequestDelegate _next;

    public SecurityBinaryBridgeMiddleware(RequestDelegate next)
    {
        _next = next;
    }

    public async Task InvokeAsync(HttpContext context, IAedsEncoder aeds)
    {
        if (!context.Request.Path.StartsWithSegments(BinaryPrefix, StringComparison.OrdinalIgnoreCase, out PathString remaining))
        {
            await _next(context);
            return;
        }

        if (!TryResolveRoute(context.Request.Method, remaining, out SecurityBridgeRoute route))
        {
            await WriteApiErrorAsync(context, aeds, ErrorCode.NotFound, "security_binary_route_not_found", StatusCodes.Status404NotFound);
            return;
        }

        if (!AcceptsBinary(context.Request))
        {
            await WriteApiErrorAsync(context, aeds, ErrorCode.Validation, "binary_accept_required", StatusCodes.Status406NotAcceptable);
            return;
        }

        ReadOnlyMemory<byte>? requestJson = null;
        if (route.RequestFrame is not null)
        {
            Result<ReadOnlyMemory<byte>> bodyResult = await DecodeRequestPayloadAsync(context, aeds, route.RequestFrame.Value);
            if (bodyResult.IsFailure)
            {
                await WriteApiErrorAsync(context, aeds, bodyResult.Error.Code, bodyResult.Error.Message, StatusCodes.Status400BadRequest);
                return;
            }

            requestJson = bodyResult.Value;
        }
        else if (context.Request.ContentLength.GetValueOrDefault() > 0)
        {
            await WriteApiErrorAsync(context, aeds, ErrorCode.Validation, "security_binary_body_not_allowed", StatusCodes.Status400BadRequest);
            return;
        }

        await BridgeToLegacySecurityEndpointAsync(context, aeds, remaining, route, requestJson);
    }

    private async Task BridgeToLegacySecurityEndpointAsync(
        HttpContext context,
        IAedsEncoder aeds,
        PathString remaining,
        SecurityBridgeRoute route,
        ReadOnlyMemory<byte>? requestJson)
    {
        PathString originalPath = context.Request.Path;
        Stream originalRequestBody = context.Request.Body;
        string? originalContentType = context.Request.ContentType;
        long? originalContentLength = context.Request.ContentLength;
        StringValues originalAccept = context.Request.Headers.Accept;
        Stream originalResponseBody = context.Response.Body;
        bool hadBridgeMarker = context.Items.TryGetValue(BinaryBridgeInternalRequest.ItemKey, out object? originalBridgeMarker);

        await using var capture = new MemoryStream();
        try
        {
            context.Request.Path = new PathString($"{LegacyPrefix}{remaining}");
            context.Request.Headers.Accept = JsonContentType;
            context.Items[BinaryBridgeInternalRequest.ItemKey] = true;
            if (requestJson is { } json)
            {
                context.Request.Body = new MemoryStream(json.ToArray());
                context.Request.ContentType = JsonContentType;
                context.Request.ContentLength = json.Length;
            }
            else
            {
                context.Request.Body = Stream.Null;
                context.Request.ContentType = null;
                context.Request.ContentLength = null;
            }

            context.Response.Body = capture;

            await _next(context);

            context.Response.Body = originalResponseBody;
            await WriteLegacyEnvelopeAsAedsAsync(context, aeds, route.ResponseFrame, capture.ToArray());
        }
        finally
        {
            context.Request.Path = originalPath;
            context.Request.Body = originalRequestBody;
            context.Request.ContentType = originalContentType;
            context.Request.ContentLength = originalContentLength;
            context.Request.Headers.Accept = originalAccept;
            context.Response.Body = originalResponseBody;
            if (hadBridgeMarker)
            {
                context.Items[BinaryBridgeInternalRequest.ItemKey] = originalBridgeMarker!;
            }
            else
            {
                context.Items.Remove(BinaryBridgeInternalRequest.ItemKey);
            }
        }
    }

    private static async Task<Result<ReadOnlyMemory<byte>>> DecodeRequestPayloadAsync(
        HttpContext context,
        IAedsEncoder aeds,
        AedsFrameType expectedFrame)
    {
        if (!IsBinaryContentType(context.Request.ContentType))
        {
            return Result<ReadOnlyMemory<byte>>.Failure(ErrorCode.Validation, "binary_content_type_required");
        }

        if (context.Request.ContentLength.HasValue && context.Request.ContentLength.Value > MaxSecurityFrameBytes)
        {
            return Result<ReadOnlyMemory<byte>>.Failure(ErrorCode.Validation, "security_binary_frame_too_large");
        }

        byte[] frame;
        try
        {
            frame = await ReadBodyWithLimitAsync(context.Request.Body, MaxSecurityFrameBytes, context.RequestAborted);
        }
        catch (InvalidOperationException)
        {
            return Result<ReadOnlyMemory<byte>>.Failure(ErrorCode.Validation, "security_binary_frame_too_large");
        }

        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);
        if (decoded.IsFailure)
        {
            return Result<ReadOnlyMemory<byte>>.Failure(ErrorCode.Validation, "security_binary_frame_invalid");
        }

        AedsDecodeResult decodedFrame = decoded.Value;
        if (decodedFrame.FrameType != expectedFrame)
        {
            return Result<ReadOnlyMemory<byte>>.Failure(ErrorCode.Validation, "security_binary_frame_type_mismatch");
        }

        return Result<ReadOnlyMemory<byte>>.Success(decodedFrame.Payload);
    }

    private static async Task<byte[]> ReadBodyWithLimitAsync(Stream body, int maxBytes, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        byte[] chunk = new byte[16 * 1024];
        while (true)
        {
            int read = await body.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken);
            if (read == 0)
            {
                break;
            }

            if (buffer.Length > maxBytes - read)
            {
                throw new InvalidOperationException("security_binary_frame_too_large");
            }

            buffer.Write(chunk, 0, read);
        }

        return buffer.ToArray();
    }

    private static async Task WriteLegacyEnvelopeAsAedsAsync(
        HttpContext context,
        IAedsEncoder aeds,
        AedsFrameType responseFrame,
        byte[] legacyResponseBody)
    {
        ClearResponseHeaders(context);

        if (legacyResponseBody.Length == 0)
        {
            await WriteApiErrorAsync(
                context,
                aeds,
                MapStatusCode(context.Response.StatusCode),
                $"HTTP {context.Response.StatusCode}",
                context.Response.StatusCode > 0 ? context.Response.StatusCode : StatusCodes.Status500InternalServerError);
            return;
        }

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(legacyResponseBody);
        }
        catch (JsonException)
        {
            await WriteApiErrorAsync(
                context,
                aeds,
                ErrorCode.InfraFailure,
                "security_legacy_envelope_invalid",
                StatusCodes.Status500InternalServerError);
            return;
        }

        using (document)
        {
            JsonElement root = document.RootElement;
            bool success = root.TryGetProperty("success", out JsonElement successElement) && successElement.ValueKind == JsonValueKind.True;
            if (!success || context.Response.StatusCode >= 400)
            {
                string message = root.TryGetProperty("message", out JsonElement messageElement) && messageElement.ValueKind == JsonValueKind.String
                    ? messageElement.GetString() ?? $"HTTP {context.Response.StatusCode}"
                    : $"HTTP {context.Response.StatusCode}";
                await WriteApiErrorAsync(context, aeds, MapStatusCode(context.Response.StatusCode), message, context.Response.StatusCode);
                return;
            }

            ReadOnlyMemory<byte> payload = root.TryGetProperty("data", out JsonElement dataElement) && dataElement.ValueKind != JsonValueKind.Null
                ? Encoding.UTF8.GetBytes(dataElement.GetRawText())
                : JsonNullPayload;
            byte[] frame = aeds.Encode(responseFrame, payload.Span);
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = BinaryContentType;
            context.Response.ContentLength = frame.Length;
            await context.Response.Body.WriteAsync(frame, context.RequestAborted);
        }
    }

    private static async Task WriteApiErrorAsync(
        HttpContext context,
        IAedsEncoder aeds,
        ErrorCode code,
        string message,
        int statusCode)
    {
        ClearResponseHeaders(context);
        int normalizedStatus = statusCode > 0 ? statusCode : StatusCodes.Status500InternalServerError;
        byte[] payload = PodBinaryCodec.EncodeApiError(
            ErrorDetail.Create(code, message, traceId: context.TraceIdentifier),
            normalizedStatus);
        byte[] frame = aeds.Encode(AedsFrameType.ApiError, payload);
        context.Response.StatusCode = normalizedStatus;
        context.Response.ContentType = BinaryContentType;
        context.Response.ContentLength = frame.Length;
        await context.Response.Body.WriteAsync(frame, context.RequestAborted);
    }

    private static void ClearResponseHeaders(HttpContext context)
    {
        context.Response.Headers.ContentType = BinaryContentType;
        context.Response.Headers.ContentLength = null;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
    }

    private static bool AcceptsBinary(HttpRequest request)
    {
        if (request.Headers.Accept.Count == 0)
        {
            return true;
        }

        return request.Headers.Accept.Any(static value =>
            !string.IsNullOrEmpty(value) &&
            (value.Contains(BinaryContentType, StringComparison.OrdinalIgnoreCase) ||
             value.Contains("*/*", StringComparison.Ordinal)));
    }

    private static bool IsBinaryContentType(string? contentType)
        => contentType?.StartsWith(BinaryContentType, StringComparison.OrdinalIgnoreCase) == true;

    private static ErrorCode MapStatusCode(int statusCode)
        => statusCode switch
        {
            StatusCodes.Status400BadRequest => ErrorCode.Validation,
            StatusCodes.Status401Unauthorized => ErrorCode.Unauthorized,
            StatusCodes.Status403Forbidden => ErrorCode.Forbidden,
            StatusCodes.Status404NotFound => ErrorCode.NotFound,
            StatusCodes.Status409Conflict => ErrorCode.Conflict,
            StatusCodes.Status428PreconditionRequired => ErrorCode.Forbidden,
            _ => ErrorCode.InfraFailure
        };

    internal static bool TryResolveRoute(string method, PathString remaining, out SecurityBridgeRoute route)
    {
        string[] segments = (remaining.Value ?? string.Empty).Split('/', StringSplitOptions.RemoveEmptyEntries);
        route = default;

        if (HttpMethods.IsGet(method) && segments is ["overview"])
            return Found(null, AedsFrameType.SecurityOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "overview"])
            return Found(null, AedsFrameType.AntiCrawlerOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "options"])
            return Found(null, AedsFrameType.AntiCrawlerPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["anti-crawler", "options"])
            return Found(AedsFrameType.AntiCrawlerOptionsUpdateRequest, AedsFrameType.AntiCrawlerPolicySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "options", "rollback"])
            return Found(null, AedsFrameType.AntiCrawlerPolicySnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "crawler-ranges", "status"])
            return Found(null, AedsFrameType.CrawlerRangesAdminStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "crawler-ranges", "sync"])
            return Found(null, AedsFrameType.CrawlerRangeSyncResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "risk-events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsGet(method) && segments is ["risk", "events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsGet(method) && segments is ["risk", "snapshots"])
            return Found(null, AedsFrameType.SecurityRiskSnapshotList, out route);
        if (HttpMethods.IsPost(method) && segments is ["risk", _, "reset"])
            return Found(AedsFrameType.SecurityRiskResetRequest, AedsFrameType.SecurityRiskResetResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "rules"])
            return Found(null, AedsFrameType.AntiCrawlerRuleList, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "rules"])
            return Found(AedsFrameType.AntiCrawlerRuleRequest, AedsFrameType.AntiCrawlerRuleResponse, out route);
        if (HttpMethods.IsPut(method) && segments is ["anti-crawler", "rules", _])
            return Found(AedsFrameType.AntiCrawlerRuleRequest, AedsFrameType.AntiCrawlerRuleResponse, out route);
        if (HttpMethods.IsDelete(method) && segments is ["anti-crawler", "rules", _])
            return Found(null, AedsFrameType.AntiCrawlerRuleDeleteResponse, out route);

        if (HttpMethods.IsGet(method) && segments is ["anti-crawler", "allowlist" or "blocklist"])
            return Found(null, AedsFrameType.AntiCrawlerListEntryList, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "allowlist" or "blocklist"])
            return Found(AedsFrameType.AntiCrawlerListEntryRequest, AedsFrameType.AntiCrawlerListEntryResponse, out route);
        if (HttpMethods.IsDelete(method) && segments is ["anti-crawler", "allowlist" or "blocklist", _])
            return Found(null, AedsFrameType.AntiCrawlerListEntryDeleteResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["anti-crawler", "simulate"])
            return Found(AedsFrameType.AntiCrawlerSimulationRequest, AedsFrameType.AntiCrawlerSimulationResult, out route);

        if (HttpMethods.IsGet(method) && segments is ["pow", "overview"])
            return Found(null, AedsFrameType.PowOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["pow", "options"])
            return Found(null, AedsFrameType.PowPolicySnapshot, out route);
        if (HttpMethods.IsPut(method) && segments is ["pow", "options"])
            return Found(AedsFrameType.PowOptionsUpdateRequest, AedsFrameType.PowPolicySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["pow", "options", "rollback"])
            return Found(null, AedsFrameType.PowPolicySnapshot, out route);
        if (HttpMethods.IsGet(method) && segments is ["pow", "events"])
            return Found(null, AedsFrameType.SecurityRiskEventList, out route);
        if (HttpMethods.IsPost(method) && segments is ["pow", "simulate"])
            return Found(AedsFrameType.AntiCrawlerSimulationRequest, AedsFrameType.AntiCrawlerSimulationResult, out route);

        return false;
    }

    private static bool Found(AedsFrameType? requestFrame, AedsFrameType responseFrame, out SecurityBridgeRoute route)
    {
        route = new SecurityBridgeRoute(requestFrame, responseFrame);
        return true;
    }

    internal readonly record struct SecurityBridgeRoute(AedsFrameType? RequestFrame, AedsFrameType ResponseFrame);
}
