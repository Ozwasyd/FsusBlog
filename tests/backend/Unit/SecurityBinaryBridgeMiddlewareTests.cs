using System.Text;
using System.Text.Json;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Middlewares;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityBinaryBridgeMiddlewareTests
{
    [Fact]
    public async Task InvokeAsync_ValidOptionsFrame_RewritesToLegacyEndpointAndReturnsAedsFrame()
    {
        var aeds = new AedsEncoder();
        var middleware = new SecurityBinaryBridgeMiddleware(async context =>
        {
            Assert.Equal("/api/admin/security/anti-crawler/options", context.Request.Path.Value);
            Assert.Equal("application/json", context.Request.ContentType);
            Assert.Equal("application/json", context.Request.Headers.Accept.ToString());
            using JsonDocument request = await JsonDocument.ParseAsync(context.Request.Body);
            Assert.Equal("observe", request.RootElement.GetProperty("mode").GetString());

            context.Response.StatusCode = StatusCodes.Status200OK;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync(
                """{"success":true,"data":{"snapshotId":"sec-1","reason":"test","options":{"mode":"observe"}}}""");
        });
        DefaultHttpContext context = CreateContext(
            "/api/binary/admin/security/anti-crawler/options",
            HttpMethods.Put,
            aeds.Encode(AedsFrameType.AntiCrawlerOptionsUpdateRequest, Encoding.UTF8.GetBytes("""{"mode":"observe"}""")));

        await middleware.InvokeAsync(context, aeds);

        AedsDecodeResult decoded = DecodeResponse(context, aeds);
        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.AntiCrawlerPolicySnapshot, decoded.FrameType);
        string payload = Encoding.UTF8.GetString(decoded.Payload.Span);
        Assert.Contains("\"snapshotId\":\"sec-1\"", payload, StringComparison.Ordinal);
    }

    [Fact]
    public async Task InvokeAsync_WrongRequestFrame_ReturnsApiErrorWithoutCallingLegacyEndpoint()
    {
        var aeds = new AedsEncoder();
        bool called = false;
        var middleware = new SecurityBinaryBridgeMiddleware(context =>
        {
            called = true;
            return Task.CompletedTask;
        });
        DefaultHttpContext context = CreateContext(
            "/api/binary/admin/security/anti-crawler/options",
            HttpMethods.Put,
            aeds.Encode(AedsFrameType.PowOptionsUpdateRequest, Encoding.UTF8.GetBytes("{}")));

        await middleware.InvokeAsync(context, aeds);

        AedsDecodeResult decoded = DecodeResponse(context, aeds);
        Assert.False(called);
        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("security_binary_frame_type_mismatch", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    public async Task InvokeAsync_LegacyMfaFailureEnvelope_ReturnsApiErrorFrame()
    {
        var aeds = new AedsEncoder();
        var middleware = new SecurityBinaryBridgeMiddleware(async context =>
        {
            context.Response.StatusCode = StatusCodes.Status428PreconditionRequired;
            context.Response.ContentType = "application/json";
            await context.Response.WriteAsync("""{"success":false,"message":"MFA_PROOF_REQUIRED"}""");
        });
        DefaultHttpContext context = CreateContext(
            "/api/binary/admin/security/risk/ip/reset",
            HttpMethods.Post,
            aeds.Encode(AedsFrameType.SecurityRiskResetRequest, Encoding.UTF8.GetBytes("""{"subject":"127.0.0.1","reason":"test"}""")));

        await middleware.InvokeAsync(context, aeds);

        AedsDecodeResult decoded = DecodeResponse(context, aeds);
        Assert.Equal(StatusCodes.Status428PreconditionRequired, context.Response.StatusCode);
        Assert.Equal(AedsFrameType.ApiError, decoded.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Payload, out var errorPod));
        Assert.Equal("MFA_PROOF_REQUIRED", PodBinaryCodec.ToErrorDetail(errorPod).Message);
    }

    [Fact]
    public void TryResolveRoute_KnowsRiskListAndPowRoutes()
    {
        Assert.True(SecurityBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Post,
            new PathString("/risk/ip/reset"),
            out var resetRoute));
        Assert.Equal(AedsFrameType.SecurityRiskResetRequest, resetRoute.RequestFrame);
        Assert.Equal(AedsFrameType.SecurityRiskResetResponse, resetRoute.ResponseFrame);

        Assert.True(SecurityBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Delete,
            new PathString("/anti-crawler/allowlist/entry-1"),
            out var listRoute));
        Assert.Null(listRoute.RequestFrame);
        Assert.Equal(AedsFrameType.AntiCrawlerListEntryDeleteResponse, listRoute.ResponseFrame);

        Assert.True(SecurityBinaryBridgeMiddleware.TryResolveRoute(
            HttpMethods.Put,
            new PathString("/pow/options"),
            out var powRoute));
        Assert.Equal(AedsFrameType.PowOptionsUpdateRequest, powRoute.RequestFrame);
        Assert.Equal(AedsFrameType.PowPolicySnapshot, powRoute.ResponseFrame);
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
