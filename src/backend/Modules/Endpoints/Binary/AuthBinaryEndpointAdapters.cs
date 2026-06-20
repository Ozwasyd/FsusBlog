using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

internal readonly record struct AuthBinaryReadResult<T>(
    bool IsSuccess,
    T Value,
    ErrorDetail Error);

internal static class AuthBinaryRequestReader
{
    public static async Task<AuthBinaryReadResult<AuthLoginRequestCoreModel>> ReadLoginAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        BinaryRequestPayload payload = await ReadPayloadAsync(httpContext, aeds, AedsFrameType.AuthLoginRequest, cancellationToken);
        if (!payload.IsSuccess)
        {
            return Fail<AuthLoginRequestCoreModel>(payload.Error);
        }

        return PodBinaryCodec.TryDecodeAuthLoginRequest(payload.Payload, out AuthLoginRequestCoreModel request)
            ? Ok(request)
            : Fail<AuthLoginRequestCoreModel>(ErrorDetail.Create(ErrorCode.Validation, "登录请求体非法"));
    }

    public static async Task<AuthBinaryReadResult<AuthRegisterRequestCoreModel>> ReadRegisterAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        BinaryRequestPayload payload = await ReadPayloadAsync(httpContext, aeds, AedsFrameType.AuthRegisterRequest, cancellationToken);
        if (!payload.IsSuccess)
        {
            return Fail<AuthRegisterRequestCoreModel>(payload.Error);
        }

        return PodBinaryCodec.TryDecodeAuthRegisterRequest(payload.Payload, out AuthRegisterRequestCoreModel request)
            ? Ok(request)
            : Fail<AuthRegisterRequestCoreModel>(ErrorDetail.Create(ErrorCode.Validation, "注册请求体非法"));
    }

    public static async Task<AuthBinaryReadResult<AuthAnonymousBootstrapRequestCoreModel>> ReadAnonymousBootstrapAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        CancellationToken cancellationToken)
    {
        BinaryRequestPayload payload = await ReadPayloadAsync(httpContext, aeds, AedsFrameType.AuthAnonymousBootstrapRequest, cancellationToken);
        if (!payload.IsSuccess)
        {
            return Fail<AuthAnonymousBootstrapRequestCoreModel>(payload.Error);
        }

        return PodBinaryCodec.TryDecodeAuthAnonymousBootstrapRequest(payload.Payload, out AuthAnonymousBootstrapRequestCoreModel request)
            ? Ok(request)
            : Fail<AuthAnonymousBootstrapRequestCoreModel>(ErrorDetail.Create(ErrorCode.Validation, "匿名账号初始化请求体非法"));
    }

    private static Task<BinaryRequestPayload> ReadPayloadAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        AedsFrameType expectedFrameType,
        CancellationToken cancellationToken)
        => httpContext.RequestServices
            .GetRequiredService<IBinaryEndpointRequestContext>()
            .ReadFrameAsync(httpContext, aeds, expectedFrameType, cancellationToken);

    private static AuthBinaryReadResult<T> Ok<T>(T value)
        => new(true, value, ErrorDetail.None);

    private static AuthBinaryReadResult<T> Fail<T>(ErrorDetail error)
        => new(false, default!, error);
}

internal static class AuthBinaryResponseWriter
{
    public static BinaryFrameResult Error(IAedsEncoder aeds, ErrorDetail error)
        => BinaryResults.FromError(error, aeds);

    public static BinaryFrameResult LoginFlow(IAedsEncoder aeds, AuthLoginFlowDto flow)
        => BinaryResults.Frame(aeds, AedsFrameType.AuthLoginFlow, writer => PodBinaryCodec.WriteAuthLoginFlow(flow, writer));
}
