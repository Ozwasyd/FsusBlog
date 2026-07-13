using System.Reflection;
using System.Security.Claims;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Shared.Contracts.Models;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RejectIdentifiedPrincipalFilterTests
{
    [Fact]
    public async Task InvokeAsync_UnidentifiedRequest_EntersBusinessLogic()
    {
        var logger = new CapturingLogger<RejectIdentifiedPrincipalFilter>();
        var filter = new RejectIdentifiedPrincipalFilter(logger);
        DefaultHttpContext context = CreateContext();
        bool nextCalled = false;

        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.True(nextCalled);
        Assert.Equal("ok", result);
        Assert.Empty(logger.Entries);
    }

    [Theory]
    [InlineData("Cookie", "AccessToken=secret-cookie")]
    [InlineData("Authorization", "Bearer secret-token")]
    [InlineData(RejectIdentifiedPrincipalFilter.AccessTokenBridgeHeaderName, "secret-bridge-token")]
    [InlineData(RejectIdentifiedPrincipalFilter.SessionBridgeHeaderName, "secret-session-id")]
    public async Task InvokeAsync_IdentifyingHeader_ReturnsAnonymousIdentityContaminatedApiError(string headerName, string headerValue)
    {
        var filter = new RejectIdentifiedPrincipalFilter(new CapturingLogger<RejectIdentifiedPrincipalFilter>());
        DefaultHttpContext context = CreateContext();
        context.Request.Headers[headerName] = headerValue;
        bool nextCalled = false;

        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextCalled = true;
                return ValueTask.FromResult<object?>("ok");
            });

        Assert.False(nextCalled);
        ErrorDetail error = await ExecuteApiErrorAsync(result, context);
        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(ErrorCode.Forbidden, error.Code);
        Assert.Equal(RejectIdentifiedPrincipalFilter.ErrorDetails, error.Details);
        Assert.Equal(RejectIdentifiedPrincipalFilter.PublicErrorMessage, error.Message);
        Assert.Equal(context.TraceIdentifier, error.TraceId);
    }

    [Fact]
    public async Task InvokeAsync_AuthenticatedPrincipal_ReturnsAnonymousIdentityContaminatedApiError()
    {
        var filter = new RejectIdentifiedPrincipalFilter(new CapturingLogger<RejectIdentifiedPrincipalFilter>());
        DefaultHttpContext context = CreateContext();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(
            [new Claim(ClaimTypes.NameIdentifier, "42")],
            "unit"));

        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ => ValueTask.FromResult<object?>("ok"));

        ErrorDetail error = await ExecuteApiErrorAsync(result, context);
        Assert.Equal(StatusCodes.Status403Forbidden, context.Response.StatusCode);
        Assert.Equal(RejectIdentifiedPrincipalFilter.ErrorDetails, error.Details);
    }

    [Fact]
    public async Task InvokeAsync_ContaminatedRequestRejectsBeforeComposedPowFilter()
    {
        var filter = new RejectIdentifiedPrincipalFilter(new CapturingLogger<RejectIdentifiedPrincipalFilter>());
        DefaultHttpContext context = CreateContext();
        context.Request.Headers.Cookie = "AccessToken=secret-cookie";
        bool nextFilterCalled = false;

        object? result = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ =>
            {
                nextFilterCalled = true;
                return ValueTask.FromResult<object?>("pow-filter-would-run");
            });

        Assert.False(nextFilterCalled);
        Assert.Equal(StatusCodes.Status403Forbidden, await ExecuteStatusAsync(result, context));
    }

    [Fact]
    public async Task InvokeAsync_ContaminatedRequestLogContainsOnlyPresenceFlags()
    {
        var logger = new CapturingLogger<RejectIdentifiedPrincipalFilter>();
        var filter = new RejectIdentifiedPrincipalFilter(logger);
        DefaultHttpContext context = CreateContext();
        context.TraceIdentifier = "trace-strong-anon";
        context.Request.Path = "/api/binary/comment/anonymous";
        context.Request.Headers.Cookie = "AccessToken=secret-cookie";
        context.Request.Headers.Authorization = "Bearer secret-token";
        context.Request.Headers[RejectIdentifiedPrincipalFilter.AccessTokenBridgeHeaderName] = "secret-bridge-token";

        _ = await filter.InvokeAsync(
            new TestEndpointFilterInvocationContext(context),
            _ => ValueTask.FromResult<object?>("ok"));

        LogEntry entry = Assert.Single(logger.Entries);
        Assert.Equal(LogLevel.Warning, entry.Level);
        Assert.Contains("trace-strong-anon", entry.RenderedMessage, StringComparison.Ordinal);
        Assert.Contains("/api/binary/comment/anonymous", entry.RenderedMessage, StringComparison.Ordinal);
        Assert.Contains("cookie_header", entry.RenderedMessage, StringComparison.Ordinal);
        Assert.Contains("HasCookie=True", entry.RenderedProperties, StringComparison.Ordinal);
        Assert.Contains("HasAuthorization=True", entry.RenderedProperties, StringComparison.Ordinal);
        Assert.Contains("HasBridgeHeader=True", entry.RenderedProperties, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-cookie", entry.RenderedMessage, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-token", entry.RenderedMessage, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-bridge-token", entry.RenderedMessage, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-cookie", entry.RenderedProperties, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-token", entry.RenderedProperties, StringComparison.Ordinal);
        Assert.DoesNotContain("secret-bridge-token", entry.RenderedProperties, StringComparison.Ordinal);
    }

    [Fact]
    public void RequireStrongAnonymousRequest_AddsReusableMetadataAndFilterHasInfrastructureFreeConstructor()
    {
        WebApplication app = WebApplication.CreateBuilder().Build();
        app.MapPost("/anonymous", static () => Results.Ok())
            .RequireStrongAnonymousRequest();

        RouteEndpoint endpoint = Assert.IsType<RouteEndpoint>(Assert.Single(
            ((IEndpointRouteBuilder)app).DataSources.SelectMany(static source => source.Endpoints)));
        Assert.Same(
            StrongAnonymousRequestMetadata.Instance,
            endpoint.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());

        ConstructorInfo constructor = Assert.Single(typeof(RejectIdentifiedPrincipalFilter).GetConstructors());
        ParameterInfo parameter = Assert.Single(constructor.GetParameters());
        Assert.Equal(typeof(ILogger<RejectIdentifiedPrincipalFilter>), parameter.ParameterType);
        Assert.DoesNotContain(constructor.GetParameters(), static item =>
            item.ParameterType.Namespace?.StartsWith("SqlSugar", StringComparison.Ordinal) == true
            || item.ParameterType.Namespace?.StartsWith("StackExchange.Redis", StringComparison.Ordinal) == true);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public void ExistingLoginBackedCommentEndpoint_RequiresAuthorizationWithoutStrongAnonymousMetadata()
    {
        using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        RouteEndpoint endpoint = EndpointContractApplication.Find(
            app,
            "/api/binary/comment",
            HttpMethods.Post);

        Assert.NotNull(endpoint.Metadata.GetMetadata<IAuthorizeData>());
        Assert.Null(endpoint.Metadata.GetMetadata<StrongAnonymousRequestMetadata>());
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.RequestServices = new ServiceCollection()
            .AddSingleton<IAedsEncoder, AedsEncoder>()
            .BuildServiceProvider();
        context.TraceIdentifier = "trace-test";
        context.Request.Path = "/api/binary/comment/anonymous";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static async Task<int> ExecuteStatusAsync(object? result, DefaultHttpContext context)
    {
        Assert.IsAssignableFrom<IResult>(result);
        await ((IResult)result!).ExecuteAsync(context);
        return context.Response.StatusCode;
    }

    private static async Task<ErrorDetail> ExecuteApiErrorAsync(object? result, DefaultHttpContext context)
    {
        Assert.IsAssignableFrom<IResult>(result);
        await ((IResult)result!).ExecuteAsync(context);
        context.Response.Body.Position = 0;
        byte[] frame = ((MemoryStream)context.Response.Body).ToArray();
        Result<AedsDecodeResult> decoded = new AedsEncoder().TryDecode(frame);
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out ApiErrorPod pod));
        return PodBinaryCodec.ToErrorDetail(pod);
    }

    private sealed class TestEndpointFilterInvocationContext(HttpContext httpContext) : EndpointFilterInvocationContext
    {
        public override HttpContext HttpContext { get; } = httpContext;

        public override IList<object?> Arguments { get; } = [];

        public override T GetArgument<T>(int index) => (T)Arguments[index]!;
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<LogEntry> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            string renderedProperties = state is IEnumerable<KeyValuePair<string, object?>> properties
                ? string.Join(";", properties.Select(static item => $"{item.Key}={item.Value}"))
                : string.Empty;
            Entries.Add(new LogEntry(logLevel, formatter(state, exception), renderedProperties));
        }
    }

    private sealed record LogEntry(LogLevel Level, string RenderedMessage, string RenderedProperties);

}
