using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.Filters;

public sealed partial class CommentRiskActionFilter(
    IAedsEncoder aeds,
    ILogger<CommentRiskActionFilter> logger) : IEndpointFilter
{
    private const int BufferThresholdBytes = 4096;
    private const int MaxPreviewFrameBytes = AedsFrameHeader.Size + CommentLimits.CreatePayloadMaxBytes;

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        string actionName = await ResolveActionNameAsync(context.HttpContext);
        context.HttpContext.Items[RiskActionEndpointMetadata.HttpContextItemKey] =
            RiskActionRegistry.Default.CreateMetadata(actionName);
        return await next(context);
    }

    private async ValueTask<string> ResolveActionNameAsync(HttpContext context)
    {
        HttpRequest request = context.Request;
        if (request.ContentLength is > MaxPreviewFrameBytes)
        {
            return RiskActionNames.CommentCreate;
        }

        request.EnableBuffering(BufferThresholdBytes, MaxPreviewFrameBytes);
        try
        {
            using var frameBuffer = new MemoryStream(
                request.ContentLength is > 0 and <= MaxPreviewFrameBytes
                    ? (int)request.ContentLength.Value
                    : BufferThresholdBytes);
            await request.Body.CopyToAsync(frameBuffer, context.RequestAborted);
            if (frameBuffer.Length == 0 || frameBuffer.Length > MaxPreviewFrameBytes)
            {
                return RiskActionNames.CommentCreate;
            }

            var decoded = aeds.TryDecode(frameBuffer.GetBuffer().AsMemory(0, (int)frameBuffer.Length));
            if (!decoded.IsSuccess)
            {
                return RiskActionNames.CommentCreate;
            }

            AedsDecodeResult frame = decoded.Value;
            return frame.FrameType switch
            {
                AedsFrameType.CommentCreateRequest when PodBinaryCodec.TryDecodeCommentCreateRequest(frame.Payload, out CommentCreateRequestCoreModel v2Request)
                    => IsReply(v2Request) ? RiskActionNames.CommentReply : RiskActionNames.CommentCreate,
                _ => RiskActionNames.CommentCreate
            };
        }
        catch (IOException ex)
        {
            LogCommentRiskActionPreviewFailed(logger, context.TraceIdentifier, ex.Message);
            return RiskActionNames.CommentCreate;
        }
        catch (InvalidOperationException ex)
        {
            LogCommentRiskActionPreviewFailed(logger, context.TraceIdentifier, ex.Message);
            return RiskActionNames.CommentCreate;
        }
        finally
        {
            if (context.Request.Body.CanSeek)
            {
                context.Request.Body.Position = 0;
            }
        }
    }

    private static bool IsReply(in CommentCreateRequestCoreModel request)
        => !string.IsNullOrWhiteSpace(request.ParentId)
            || !string.IsNullOrWhiteSpace(request.RootId)
            || !string.IsNullOrWhiteSpace(request.ReplyToCommentId);

    [LoggerMessage(EventId = 152, Level = LogLevel.Debug, Message = "Comment RiskControl action preview failed | TraceId: {TraceId} | Reason: {Reason}")]
    private static partial void LogCommentRiskActionPreviewFailed(ILogger logger, string traceId, string reason);
}
