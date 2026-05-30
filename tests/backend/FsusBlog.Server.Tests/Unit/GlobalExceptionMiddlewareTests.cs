using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Codecs;
using FsusBlog.Server.Infrastructure.Middlewares;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class GlobalExceptionMiddlewareTests
{
    private static GlobalExceptionMiddleware BuildMiddleware(
        RequestDelegate next,
        bool isDevelopment = false)
    {
        var env = isDevelopment
            ? (IHostEnvironment)new FakeHostEnvironment(Environments.Development)
            : new FakeHostEnvironment(Environments.Production);

        return new GlobalExceptionMiddleware(next, NullLogger<GlobalExceptionMiddleware>.Instance, env);
    }

    [Fact]
    public async Task InvokeAsync_NoException_CallsNext()
    {
        bool nextCalled = false;
        var middleware = BuildMiddleware(ctx =>
        {
            nextCalled = true;
            return Task.CompletedTask;
        });

        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        Assert.True(nextCalled);
    }

    [Fact]
    public async Task InvokeAsync_OperationCanceledException_DoesNotWriteResponse()
    {
        var middleware = BuildMiddleware(_ => throw new OperationCanceledException("cancelled"));

        var context = new DefaultHttpContext();
        var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await middleware.InvokeAsync(context);

        // OperationCanceledException is handled silently - no body written
        Assert.Equal(0, responseBody.Length);
    }

    [Fact]
    public async Task InvokeAsync_ArgumentException_Returns400()
    {
        var middleware = BuildMiddleware(_ => throw new ArgumentException("bad argument"));

        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_BadHttpRequestException_Returns400WithoutBindingDetail()
    {
        var middleware = BuildMiddleware(_ => throw new BadHttpRequestException(
            "Failed to bind parameter \"Nullable<int> categoryId\" from \"' OR '1'='1\".",
            StatusCodes.Status400BadRequest));

        var context = new DefaultHttpContext();
        var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await middleware.InvokeAsync(context);

        responseBody.Position = 0;
        string body = DecodeApiErrorMessage(responseBody);

        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal("请求参数非法", body);
        Assert.DoesNotContain("Failed to bind parameter", body);
        Assert.DoesNotContain("' OR '1'='1", body);
    }

    [Fact]
    public async Task InvokeAsync_UnauthorizedAccessException_Returns401()
    {
        var middleware = BuildMiddleware(_ => throw new UnauthorizedAccessException("not allowed"));

        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status401Unauthorized, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_KeyNotFoundException_Returns404()
    {
        var middleware = BuildMiddleware(_ => throw new KeyNotFoundException("not found"));

        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_NotImplementedException_Returns501()
    {
        var middleware = BuildMiddleware(_ => throw new NotImplementedException("not implemented"));

        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status501NotImplemented, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_UnknownException_Returns500()
    {
        var middleware = BuildMiddleware(_ => throw new InvalidOperationException("unexpected"));

        var context = new DefaultHttpContext();
        context.Response.Body = new MemoryStream();

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status500InternalServerError, context.Response.StatusCode);
    }

    [Fact]
    public async Task InvokeAsync_Production500_DoesNotLeakExceptionMessage()
    {
        var middleware = BuildMiddleware(
            _ => throw new InvalidOperationException("internal secret"),
            isDevelopment: false);

        var context = new DefaultHttpContext();
        var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await middleware.InvokeAsync(context);

        responseBody.Position = 0;
        string body = DecodeApiErrorMessage(responseBody);

        Assert.DoesNotContain("internal secret", body);
        Assert.Equal(StatusCodes.Status500InternalServerError, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);
    }

    [Fact]
    public async Task InvokeAsync_Development500_ShowsExceptionMessage()
    {
        var middleware = BuildMiddleware(
            _ => throw new InvalidOperationException("internal detail"),
            isDevelopment: true);

        var context = new DefaultHttpContext();
        var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await middleware.InvokeAsync(context);

        responseBody.Position = 0;
        string body = DecodeApiErrorMessage(responseBody);

        Assert.Contains("internal detail", body);
    }

    [Fact]
    public async Task InvokeAsync_BinaryAccept_WritesApiErrorFrame()
    {
        var middleware = BuildMiddleware(_ => throw new ArgumentException("bad binary"));
        var encoder = new AedsEncoder();

        var services = new ServiceCollection()
            .AddSingleton<IAedsEncoder>(encoder)
            .BuildServiceProvider();

        var context = new DefaultHttpContext
        {
            RequestServices = services
        };
        context.Request.Headers.Accept = "application/octet-stream";
        var responseBody = new MemoryStream();
        context.Response.Body = responseBody;

        await middleware.InvokeAsync(context);

        Assert.Equal(StatusCodes.Status400BadRequest, context.Response.StatusCode);
        Assert.Equal("application/octet-stream", context.Response.ContentType);

        var decoded = encoder.TryDecode(responseBody.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var pod));
        Assert.Equal(StatusCodes.Status400BadRequest, pod.HttpStatus);
        Assert.Equal("bad binary", PodUtf8Codec.FromFixed256(pod.Message));
    }

    [Fact]
    public async Task InvokeAsync_ResponseHasStarted_RethrowsException()
    {
        var middleware = BuildMiddleware(_ => throw new InvalidOperationException("after headers sent"));

        // Simulate HasStarted by using a custom feature collection
        var features = new FeatureCollection();
        var responseFeature = new FakeResponseFeature { HasStarted = true };
        features.Set<IHttpResponseFeature>(responseFeature);
        features.Set<IHttpResponseBodyFeature>(new StreamResponseBodyFeature(Stream.Null));
        features.Set<IHttpRequestFeature>(new HttpRequestFeature());

        var context = new DefaultHttpContext(features);

        await Assert.ThrowsAsync<InvalidOperationException>(
            () => middleware.InvokeAsync(context));
    }

    private sealed class FakeHostEnvironment(string environmentName) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;
        public string ApplicationName { get; set; } = "Test";
        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();
        public Microsoft.Extensions.FileProviders.IFileProvider ContentRootFileProvider { get; set; } = null!;
    }

    private sealed class FakeResponseFeature : IHttpResponseFeature
    {
        public int StatusCode { get; set; } = 200;
        public string? ReasonPhrase { get; set; }
        public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();
        public Stream Body { get; set; } = Stream.Null;
        public bool HasStarted { get; set; }

        public void OnCompleted(Func<object, Task> callback, object state) { }
        public void OnStarting(Func<object, Task> callback, object state) { }
    }

    private static string DecodeApiErrorMessage(MemoryStream responseBody)
    {
        var encoder = new AedsEncoder();
        var decoded = encoder.TryDecode(responseBody.ToArray());
        Assert.True(decoded.IsSuccess);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var pod));
        return PodUtf8Codec.FromFixed256(pod.Message);
    }
}
