using System.Buffers;
using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.Middlewares;

public sealed class AuthoringBinaryBridgeMiddleware
{
    internal const int MaxAuthoringFrameBytes = 8 * 1024 * 1024;
    private const string BinaryContentType = "application/octet-stream";
    private const string JsonContentType = "application/json";
    private const string BinaryPrefix = "/api/binary/author";
    private const string LegacyPrefix = BinaryBridgeInternalRequest.AuthoringPrefix;
    private static ReadOnlySpan<byte> JsonNullPayload => "null"u8;

    private readonly RequestDelegate _next;

    public AuthoringBinaryBridgeMiddleware(RequestDelegate next)
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

        if (!TryResolveRoute(context.Request.Method, remaining, out AuthoringBridgeRoute route))
        {
            await WriteApiErrorAsync(context, aeds, ErrorCode.NotFound, "authoring_binary_route_not_found", StatusCodes.Status404NotFound);
            return;
        }

        if (!AcceptsBinary(context.Request))
        {
            await WriteApiErrorAsync(context, aeds, ErrorCode.Validation, "binary_accept_required", StatusCodes.Status406NotAcceptable);
            return;
        }

        BinaryBridgeRequestPayload? requestJson = null;
        if (route.RequestFrame is not null)
        {
            Result<BinaryBridgeRequestPayload> bodyResult = await DecodeRequestPayloadAsync(context, aeds, route.RequestFrame.Value);
            if (bodyResult.IsFailure)
            {
                await WriteApiErrorAsync(context, aeds, bodyResult.Error.Code, bodyResult.Error.Message, StatusCodes.Status400BadRequest);
                return;
            }

            requestJson = bodyResult.Value;
        }
        else if (context.Request.ContentLength.GetValueOrDefault() > 0)
        {
            await WriteApiErrorAsync(context, aeds, ErrorCode.Validation, "authoring_binary_body_not_allowed", StatusCodes.Status400BadRequest);
            return;
        }

        try
        {
            await BridgeToLegacyAuthoringEndpointAsync(context, aeds, remaining, route, requestJson);
        }
        finally
        {
            requestJson?.Dispose();
        }
    }

    private async Task BridgeToLegacyAuthoringEndpointAsync(
        HttpContext context,
        IAedsEncoder aeds,
        PathString remaining,
        AuthoringBridgeRoute route,
        BinaryBridgeRequestPayload? requestJson)
    {
        PathString originalPath = context.Request.Path;
        Stream originalRequestBody = context.Request.Body;
        string? originalContentType = context.Request.ContentType;
        long? originalContentLength = context.Request.ContentLength;
        StringValues originalAccept = context.Request.Headers.Accept;
        Stream originalResponseBody = context.Response.Body;
        bool hadBridgeMarker = context.Items.TryGetValue(BinaryBridgeInternalRequest.ItemKey, out object? originalBridgeMarker);

        using var capture = new PooledBinaryBridgeBuffer();
        try
        {
            context.Request.Path = new PathString($"{LegacyPrefix}{remaining}");
            context.Request.Headers.Accept = JsonContentType;
            context.Items[BinaryBridgeInternalRequest.ItemKey] = true;
            if (requestJson is { } json)
            {
                context.Request.Body = new ReadOnlyMemoryStream(json.Payload);
                context.Request.ContentType = JsonContentType;
                context.Request.ContentLength = json.Payload.Length;
            }
            else
            {
                context.Request.Body = Stream.Null;
                context.Request.ContentType = null;
                context.Request.ContentLength = null;
            }

            context.Response.Body = capture.Stream;

            await _next(context);

            context.Response.Body = originalResponseBody;
            await WriteLegacyEnvelopeAsAedsAsync(context, aeds, route.ResponseFrame, capture.WrittenMemory);
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

    private static async Task<Result<BinaryBridgeRequestPayload>> DecodeRequestPayloadAsync(
        HttpContext context,
        IAedsEncoder aeds,
        AedsFrameType expectedFrame)
    {
        if (!IsBinaryContentType(context.Request.ContentType))
        {
            return Result<BinaryBridgeRequestPayload>.Failure(ErrorCode.Validation, "binary_content_type_required");
        }

        if (context.Request.ContentLength.HasValue && context.Request.ContentLength.Value > MaxAuthoringFrameBytes)
        {
            return Result<BinaryBridgeRequestPayload>.Failure(ErrorCode.Validation, "authoring_binary_frame_too_large");
        }

        PooledBinaryBridgeBuffer frame;
        try
        {
            frame = await ReadBodyWithLimitAsync(context.Request.Body, MaxAuthoringFrameBytes, context.RequestAborted);
        }
        catch (InvalidOperationException)
        {
            return Result<BinaryBridgeRequestPayload>.Failure(ErrorCode.Validation, "authoring_binary_frame_too_large");
        }

        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame.WrittenMemory);
        if (decoded.IsFailure)
        {
            frame.Dispose();
            return Result<BinaryBridgeRequestPayload>.Failure(ErrorCode.Validation, "authoring_binary_frame_invalid");
        }

        AedsDecodeResult decodedFrame = decoded.Value;
        if (decodedFrame.FrameType != expectedFrame)
        {
            frame.Dispose();
            return Result<BinaryBridgeRequestPayload>.Failure(ErrorCode.Validation, "authoring_binary_frame_type_mismatch");
        }

        return Result<BinaryBridgeRequestPayload>.Success(new BinaryBridgeRequestPayload(frame, decodedFrame.Payload));
    }

    private static async Task<PooledBinaryBridgeBuffer> ReadBodyWithLimitAsync(Stream body, int maxBytes, CancellationToken cancellationToken)
    {
        var buffer = new PooledBinaryBridgeBuffer(Math.Min(16 * 1024, maxBytes), maxBytes);
        byte[] chunk = ArrayPool<byte>.Shared.Rent(Math.Min(16 * 1024, maxBytes));
        try
        {
            while (true)
            {
                int read = await body.ReadAsync(chunk.AsMemory(0, chunk.Length), cancellationToken);
                if (read == 0)
                {
                    break;
                }

                if (buffer.Length > maxBytes - read)
                {
                    throw new InvalidOperationException("authoring_binary_frame_too_large");
                }

                buffer.Write(chunk.AsSpan(0, read));
            }

            return buffer;
        }
        catch
        {
            buffer.Dispose();
            throw;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(chunk, clearArray: true);
        }
    }

    private static async Task WriteLegacyEnvelopeAsAedsAsync(
        HttpContext context,
        IAedsEncoder aeds,
        AedsFrameType responseFrame,
        ReadOnlyMemory<byte> legacyResponseBody)
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
                "authoring_legacy_envelope_invalid",
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
                ? WriteJsonElementPayload(responseFrame, dataElement)
                : WriteJsonLiteralPayload(responseFrame, JsonNullPayload);
            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = BinaryContentType;
            context.Response.ContentLength = payload.Length;
            await context.Response.BodyWriter.WriteAsync(payload, context.RequestAborted);
        }
    }

    private static ReadOnlyMemory<byte> WriteJsonElementPayload(AedsFrameType responseFrame, JsonElement dataElement)
    {
        using var frameWriter = new AedsFrameBufferWriter();
        using (var writer = new Utf8JsonWriter(frameWriter.PayloadWriter))
        {
            dataElement.WriteTo(writer);
        }

        frameWriter.Seal(responseFrame);
        return frameWriter.WrittenFrame.ToArray();
    }

    private static ReadOnlyMemory<byte> WriteJsonLiteralPayload(AedsFrameType responseFrame, ReadOnlySpan<byte> payload)
    {
        using var frameWriter = new AedsFrameBufferWriter();
        WriteSpan(frameWriter.PayloadWriter, payload);
        frameWriter.Seal(responseFrame);
        return frameWriter.WrittenFrame.ToArray();
    }

    private static void WriteSpan(IBufferWriter<byte> writer, ReadOnlySpan<byte> value)
    {
        Span<byte> span = writer.GetSpan(value.Length);
        value.CopyTo(span);
        writer.Advance(value.Length);
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
            _ => ErrorCode.InfraFailure
        };

    internal static bool TryResolveRoute(string method, PathString remaining, out AuthoringBridgeRoute route)
    {
        string[] segments = (remaining.Value ?? string.Empty).Split('/', StringSplitOptions.RemoveEmptyEntries);
        route = default;

        if (HttpMethods.IsPost(method) && segments is ["drafts"])
            return Found(AedsFrameType.AuthorDraftSaveRequest, AedsFrameType.AuthorDraftResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["drafts", _])
            return Found(null, AedsFrameType.AuthorDraftResponse, out route);
        if (HttpMethods.IsDelete(method) && segments is ["drafts", _])
            return Found(null, AedsFrameType.AuthorDraftDiscardResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["preview"])
            return Found(AedsFrameType.ArticlePreviewRequest, AedsFrameType.ArticlePreviewResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["prepublish-check"])
            return Found(AedsFrameType.PrepublishCheckRequest, AedsFrameType.PrepublishCheckResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["ai-assist"])
            return Found(AedsFrameType.AiAssistRequest, AedsFrameType.AiAssistResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["assets"])
            return Found(null, AedsFrameType.AssetLibraryList, out route);
        if (HttpMethods.IsPost(method) && segments is ["articles", _, "assets", "reindex"])
            return Found(null, AedsFrameType.AssetLibraryList, out route);
        if (HttpMethods.IsDelete(method) && segments is ["assets", "orphans"])
            return Found(null, AedsFrameType.AssetCleanupResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["taxonomy", "categories"])
            return Found(null, AedsFrameType.AuthorTaxonomyCategoryList, out route);
        if (HttpMethods.IsGet(method) && segments is ["taxonomy", "tags"])
            return Found(null, AedsFrameType.AuthorTaxonomyTagList, out route);
        if (HttpMethods.IsGet(method) && segments is ["analytics"])
            return Found(null, AedsFrameType.AuthorAnalytics, out route);

        if (HttpMethods.IsGet(method) && segments is ["articles", _, "revisions"])
            return Found(null, AedsFrameType.ArticleRevisionList, out route);
        if (HttpMethods.IsGet(method) && segments is ["articles", _, "revisions", _])
            return Found(null, AedsFrameType.ArticleRevisionDetail, out route);
        if (HttpMethods.IsPost(method) && segments is ["articles", _, "revisions", _, "rollback"])
            return Found(null, AedsFrameType.ArticleRevisionRollbackResponse, out route);

        if (HttpMethods.IsGet(method) && segments is ["moderation", "overview"])
            return Found(null, AedsFrameType.ModerationOverview, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "dictionaries"])
            return Found(null, AedsFrameType.ModerationDictionarySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", "reload"])
            return Found(null, AedsFrameType.ModerationDictionaryReloadResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", "rollback"])
            return Found(null, AedsFrameType.ModerationDictionarySnapshot, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", _, "enable"])
            return Found(AedsFrameType.ModerationDictionaryStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "dictionaries", _, "disable"])
            return Found(AedsFrameType.ModerationDictionaryStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "runtime", "status"])
            return Found(null, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "runtime", "global-state"])
            return Found(AedsFrameType.ModerationRuntimeGlobalStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "runtime", "region-state"])
            return Found(AedsFrameType.ModerationRuntimeRegionStateRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "regions"])
            return Found(null, AedsFrameType.ModerationRegionList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "region-groups"])
            return Found(null, AedsFrameType.ModerationRegionGroupList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "policy-templates"])
            return Found(null, AedsFrameType.ModerationPolicyTemplateList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "effective-policy", _])
            return Found(null, AedsFrameType.ModerationEffectivePolicy, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "effective-policy", "preview"])
            return Found(AedsFrameType.ModerationEffectivePolicyPreviewRequest, AedsFrameType.ModerationEffectivePolicy, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "policies"])
            return Found(null, AedsFrameType.RegionPolicySummaryList, out route);
        if (HttpMethods.IsGet(method) && segments is ["moderation", "model", "status"])
            return Found(null, AedsFrameType.ModerationModelStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "model", "runtime"])
            return Found(AedsFrameType.ModerationModelRuntimeRequest, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "model", "reload"])
            return Found(null, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "model", "rollback"])
            return Found(null, AedsFrameType.ModerationRuntimeStatus, out route);
        if (HttpMethods.IsPost(method) && segments is ["moderation", "replay", "preview"])
            return Found(AedsFrameType.ModerationReplayPreviewRequest, AedsFrameType.ModerationReplayPreview, out route);

        if (HttpMethods.IsGet(method) && segments is ["comments", "moderation"])
            return Found(null, AedsFrameType.CommentModerationQueue, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", "moderation", "bulk"])
            return Found(AedsFrameType.CommentModerationBulkRequest, AedsFrameType.CommentModerationBulkResponse, out route);
        if (HttpMethods.IsPost(method) && segments is ["comments", _, "moderation"])
            return Found(AedsFrameType.CommentModerationRequest, AedsFrameType.CommentModerationResult, out route);

        if (HttpMethods.IsGet(method) && segments is ["content", "export"])
            return Found(null, AedsFrameType.ContentBackupExport, out route);
        if (HttpMethods.IsGet(method) && segments is ["articles", _, "export"])
            return Found(null, AedsFrameType.ContentExport, out route);
        if (HttpMethods.IsPost(method) && segments is ["articles", "import"])
            return Found(AedsFrameType.ContentImportRequest, AedsFrameType.ContentImportResponse, out route);

        if (HttpMethods.IsGet(method) && segments is ["audit"])
            return Found(null, AedsFrameType.AuditLogList, out route);
        if (HttpMethods.IsGet(method) && segments is ["audit", "summary"])
            return Found(null, AedsFrameType.AuditLogSummary, out route);
        if (HttpMethods.IsGet(method) && segments is ["audit", _, "verify"])
            return Found(null, AedsFrameType.AuditTamperVerifyResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["audit", _])
            return Found(null, AedsFrameType.AuditLogDetail, out route);

        if (HttpMethods.IsGet(method) && segments is ["ops", "health"])
            return Found(null, AedsFrameType.OpsHealth, out route);
        if (HttpMethods.IsGet(method) && segments is ["ops", "backup"])
            return Found(null, AedsFrameType.BackupStatus, out route);
        if (HttpMethods.IsGet(method) && segments is ["ops", "dangerous-operations", "policy"])
            return Found(null, AedsFrameType.DangerousOperationPolicy, out route);
        if (HttpMethods.IsGet(method) && segments is ["cache", "diagnostics"])
            return Found(null, AedsFrameType.CacheDiagnostics, out route);
        if (HttpMethods.IsPost(method) && segments is ["cache", "actions"])
            return Found(AedsFrameType.AdminCacheActionRequest, AedsFrameType.AdminCacheActionResponse, out route);
        if (HttpMethods.IsGet(method) && segments is ["integrity"])
            return Found(null, AedsFrameType.IntegrityReport, out route);
        if (HttpMethods.IsGet(method) && segments is ["integrity", "fix-preview"])
            return Found(null, AedsFrameType.IntegrityFixPreview, out route);
        if (HttpMethods.IsPost(method) && segments is ["integrity", "fix"])
            return Found(AedsFrameType.IntegrityFixRequest, AedsFrameType.IntegrityFixResponse, out route);

        return false;
    }

    private static bool Found(AedsFrameType? requestFrame, AedsFrameType responseFrame, out AuthoringBridgeRoute route)
    {
        route = new AuthoringBridgeRoute(requestFrame, responseFrame);
        return true;
    }

    internal readonly record struct AuthoringBridgeRoute(AedsFrameType? RequestFrame, AedsFrameType ResponseFrame);
}
