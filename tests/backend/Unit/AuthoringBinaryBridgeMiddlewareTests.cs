using System.Text;
using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Middlewares;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringBinaryBridgeMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_ValidAuthorDraftFrame_RewritesToLegacyEndpointAndReturnsAedsFrame()
    {
        var aeds = new AedsEncoder();
        var middleware = new AuthoringBinaryBridgeMiddleware(async context =>
        {
            Assert.Equal("/_fsus/internal/binary-bridge/author/drafts", context.Request.Path.Value);
            Assert.Equal("application/json", context.Request.ContentType);
            using JsonDocument request = await JsonDocument.ParseAsync(context.Request.Body);
            Assert.Equal("Draft", request.RootElement.GetProperty("title").GetString());

            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(
                """{"success":true,"data":{"draftKey":"draft-1","status":0}}""");
        });
        DefaultHttpContext context = CreateContext(
            "/api/binary/author/drafts",
            HttpMethods.Post,
            aeds.Encode(AedsFrameType.AuthorDraftSaveRequest, Encoding.UTF8.GetBytes("""{"title":"Draft"}""")));

        await middleware.InvokeAsync(context, aeds);

        AedsDecodeResult decoded = DecodeResponse(context, aeds);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.AuthorDraftResponse, decoded.FrameType);
        string payload = Encoding.UTF8.GetString(decoded.Payload.Span);
        Assert.Contains("\"draftKey\":\"draft-1\"", payload, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InvokeAsync_WrongRequestFrame_ReturnsApiErrorWithoutCallingLegacyEndpoint()
    {
        var aeds = new AedsEncoder();
        bool called = false;
        var middleware = new AuthoringBinaryBridgeMiddleware(context =>
        {
            called = true;
            return Task.CompletedTask;
        });
        DefaultHttpContext context = CreateContext(
            "/api/binary/author/drafts",
            HttpMethods.Post,
            aeds.Encode(AedsFrameType.PrepublishCheckRequest, Encoding.UTF8.GetBytes("{}")));

        await middleware.InvokeAsync(context, aeds);

        AedsDecodeResult decoded = DecodeResponse(context, aeds);
        Assert.False(called);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("authoring_binary_frame_type_mismatch", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    public async Task InvokeAsync_LegacyFailureEnvelope_ReturnsApiErrorFrame()
    {
        var aeds = new AedsEncoder();
        var middleware = new AuthoringBinaryBridgeMiddleware(async context =>
        {
            context.Response.StatusCode = StatusCodes.Status428PreconditionRequired;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync("""{"success":false,"message":"MFA_PROOF_REQUIRED"}""");
        });
        DefaultHttpContext context = CreateContext(
            "/api/binary/author/integrity/fix",
            HttpMethods.Post,
            aeds.Encode(AedsFrameType.IntegrityFixRequest, Encoding.UTF8.GetBytes("""{"confirmPhrase":"APPLY SAFE FIX"}""")));

        await middleware.InvokeAsync(context, aeds);

        AedsDecodeResult decoded = DecodeResponse(context, aeds);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("MFA_PROOF_REQUIRED", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    public void TryResolveRoute_KnowsModerationAndAuditAuthoringRoutes()
    {
        Assert.True(AuthoringBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/moderation/effective-policy/preview"),
            out var moderationRoute));
        Assert.Equal(AedsFrameType.ModerationEffectivePolicyPreviewRequest, moderationRoute.RequestFrame);
        Assert.Equal(AedsFrameType.ModerationEffectivePolicy, moderationRoute.ResponseFrame);

        Assert.True(AuthoringBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Get,
            new PathString("/audit/42/verify"),
            out var auditRoute));
        Assert.Null(auditRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AuditTamperVerifyResponse, auditRoute.ResponseFrame);

        Assert.True(AuthoringBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/comments/moderation/nullifiers/block"),
            out var nullifierRoute));
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionRequest, nullifierRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionResponse, nullifierRoute.ResponseFrame);

        Assert.True(AuthoringBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/comments/moderation/anonymous-credentials/88001/revoke"),
            out var credentialRoute));
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionRequest, credentialRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AnonymousGovernanceActionResponse, credentialRoute.ResponseFrame);
    }

    private static DefaultHttpContext CreateContext(string path, string method, byte[]? body = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.Method = method;
        context.Request.Headers.Accept = "application/octet-stream";
        if (body is not null)
        {
            context.Request.ContentType = "application/octet-stream";
            context.Request.ContentLength = body.Length;
            context.Request.Body = new MemoryStream(body);
        }

        context.Response.Body = new MemoryStream();
        return context;
    }

    private static AedsDecodeResult DecodeResponse(DefaultHttpContext context, AedsEncoder aeds)
    {
        byte[] frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = aeds.TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        return decoded.Value;
    }
}
